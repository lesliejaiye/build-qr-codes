import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import * as qrcode from "qrcode";

export interface QRCode {
  id: string;
  handle?: string;
  title: string;
  product?: {
    id: string;
    title: string;
  };
  productVariant?: {
    id: string;
    title: string;
  };
  productTitle?: string;
  productAlt?: string;
  productImage?: string;
  destination?: string;
  destinationUrl?: string;
  scans?: number;
  shop?: string;
  image?: string;
}

export interface QRCodeInput {
  title: string;
  productId?: string;
  productVariantId?: string;
  destination?: string;
}

const QR_CODE_METAOBJECT_TYPE = "app_qrcode";

//Slugify text for handle
function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

//Generate handle for QR Code
export function generateHandle(title: string) {
  return `${slugify(title)}-${Date.now().toString(36)}`;
}

//Validate QR Code data
export function validateQRCode(data: QRCodeInput) {
  const errors: Record<string, string> = {};

  if (!data.title) {
    errors.title = "Title is required";
  }

  if (!data.productId) {
    errors.productId = "Product is required";
  }

  if (!data.destination) {
    errors.destination = "Destination is required";
  }

  if (Object.keys(errors).length) {
    return errors;
  }
}

export function getDestinationUrl(qrCode: QRCode, shop: string) {
  if (qrCode.destination === "product") {
    return `https://${shop}/products/${qrCode.product?.title}?variant=${qrCode.productVariant?.id}`;
  }

  if (!qrCode.productVariant?.id) {
    throw new Error("Unrecognised product variant ID");
  }

  return `https://${shop}/cart/${qrCode.productVariant.id}:1`;
}

export async function getQRCodeImage(handle: string, shop: string): Promise<string> {
  const url = new URL(
    `/qrcodes/${handle}/scan`,
    process.env.SHOPIFY_APP_URL || "",
  );
  url.searchParams.set("shop", shop);
  return qrcode.toDataURL(url.href);
}

export async function getQRCode(handle: string, graphql: any, shop: string): Promise<QRCode> {
  const response = await graphql(
    `#graphql
      query getQRCode($handle: MetaobjectHandleInput!) {
        metaobjectByHandle(handle: $handle) {
          id
          handle
          fields {
            key
            value
            reference {
              ... on Product {
                id
                title
              }
              ... on ProductVariant {
                id
                title
              }
            }
          }
        }
      }
    `,
    {
      variables: {
        handle: { type: QR_CODE_METAOBJECT_TYPE, handle },
      },
    },
  );

  const { data } = await response.json();
  const metaobject = data.metaobjectByHandle;

  if (!metaobject) {
    throw new Error("QR Code not found");
  }

  const baseQRCode = {
    id: metaobject.id,
    handle: metaobject.handle,
    title: metaobject.fields.find((f: any) => f.key === "title")?.value || "",
    product: metaobject.fields.find((f: any) => f.key === "product")?.reference,
    productVariant: metaobject.fields.find((f: any) => f.key === "product_variant")?.reference,
    productTitle: metaobject.fields.find((f: any) => f.key === "product")?.reference?.title || "",
    destination: metaobject.fields.find((f: any) => f.key === "destination")?.value,
    scans: metaobject.fields.find((f: any) => f.key === "scans")?.value
      ? parseInt(metaobject.fields.find((f: any) => f.key === "scans")?.value)
      : 0,
    shop,
  };

  const qrCode: QRCode = {
    ...baseQRCode,
    destinationUrl: getDestinationUrl(baseQRCode, shop),
    image: await getQRCodeImage(metaobject.handle, shop),
  };

  return qrCode;
}

export async function getQRCodes(admin: AdminApiContext, shop: string | undefined): Promise<QRCode[]> {
  const response = await admin.graphql(
   `
      query GetQRCodes($type: String!) {
        metaobjects(type: $type, first: 50, sortKey: "updated_at", reverse: true) {
          nodes {
            id
            handle
            updatedAt
            title: field(key: "title") { jsonValue }
            product: field(key: "product") {
              jsonValue
              reference {
                ... on Product {
                  handle
                  title
                  media(first: 1) {
                    nodes {
                      preview {
                        image { url altText }
                      }
                    }
                  }
                }
              }
            }
            productVariant: field(key: "product_variant") {
              reference {
                ... on ProductVariant { id legacyResourceId }
              }
            }
            destination: field(key: "destination") { jsonValue }
            scans: field(key: "scans") { jsonValue }
          }
        }
      }
    `,
    {
      variables: {
        type: QR_CODE_METAOBJECT_TYPE,
      },
    },
  );

   const { data } = await response.json();
  const metaobjects = data?.metaobjects?.nodes ?? [];

  return Promise.all(metaobjects.map((mo: any) => transformMetaobject(mo, shop)));
}

async function transformMetaobject(metaobject: any, shop: string | undefined) {
  const product = metaobject.product?.reference;
  const variant = metaobject.productVariant?.reference;
  const productId = metaobject.product?.jsonValue;

  const qrCode = {
    id: metaobject.id,
    handle: metaobject.handle,
    title: metaobject.title?.jsonValue,
    productId,
    productVariantId: variant?.id,
    productHandle: product?.handle,
    productVariantLegacyId: variant?.legacyResourceId,
    destination: metaobject.destination?.jsonValue,
    scans: metaobject.scans?.jsonValue ?? 0,
    createdAt: metaobject.updatedAt,
    productDeleted: productId && !product,
    productTitle: product?.title,
    productImage: product?.media?.nodes[0]?.preview?.image?.url,
    productAlt: product?.media?.nodes[0]?.preview?.image?.altText,
    destinationUrl: "",
    image: "",
  };

  qrCode.destinationUrl = getDestinationUrl(qrCode, shop || "");
  qrCode.image = await getQRCodeImage(metaobject.handle, shop || "");

  return qrCode;
}

export async function createQRCode(
  admin: AdminApiContext,
  input: QRCodeInput,
): Promise<QRCode> {
  const response = await admin.graphql(
    `#graphql
      mutation createQRCode($metaobject: MetaobjectCreateInput!) {
        metaobjectCreate(metaobject: $metaobject) {
          metaobject {
            id
            fields {
              key
              value
              reference {
                ... on Product {
                  id
                  title
                }
                ... on ProductVariant {
                  id
                  title
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        metaobject: {
          type: QR_CODE_METAOBJECT_TYPE,
          fields: [
            { key: "title", value: input.title },
            ...(input.productId ? [{ key: "product", value: input.productId }] : []),
            ...(input.productVariantId
              ? [{ key: "product_variant", value: input.productVariantId }]
              : []),
            ...(input.destination ? [{ key: "destination", value: input.destination }] : []),
          ],
        },
      },
    },
  );

  const data = await response.json();

  if (data.data.metaobjectCreate.userErrors.length > 0) {
    throw new Error(data.data.metaobjectCreate.userErrors[0].message);
  }

  const node = data.data.metaobjectCreate.metaobject;
  return {
    id: node.id,
    title: node.fields.find((f: any) => f.key === "title")?.value || "",
    product: node.fields.find((f: any) => f.key === "product")?.reference,
    productVariant: node.fields.find((f: any) => f.key === "product_variant")?.reference,
    destination: node.fields.find((f: any) => f.key === "destination")?.value,
    scans: 0,
  };
}

//Save QR Code to Shopify
export async function saveQRCode(handle: string, data: QRCodeInput, graphql: any) {
  const response = await graphql(
    `
      mutation UpsertQRCode($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
        metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
          metaobject { id handle }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        handle: { type: QR_CODE_METAOBJECT_TYPE, handle },
        metaobject: {
          fields: [
            { key: "title", value: data.title },
            { key: "product", value: data.productId },
            { key: "product_variant", value: data.productVariantId },
            { key: "destination", value: data.destination },
          ],
        },
      },
    },
  );

  const { data: responseData } = await response.json();
  const { metaobjectUpsert } = responseData;

  if (metaobjectUpsert.userErrors.length) {
    throw new Error(metaobjectUpsert.userErrors[0].message);
  }

  return metaobjectUpsert.metaobject;
}

//Delete QR Code from Shopify
export async function deleteQRCode(graphql: any, id: string): Promise<void> {
  const response = await graphql(
    `#graphql
      mutation deleteQRCode($id: ID!) {
        metaobjectDelete(id: $id) {
          deletedId
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: { id },
    },
  );

  const { data } = await response.json();

  if (data.metaobjectDelete.userErrors.length > 0) {
    throw new Error(data.metaobjectDelete.userErrors[0].message);
  }
}

//Increment QR Code scans
export async function incrementQRCodeScans(
  admin: AdminApiContext,
  id: string,
  shop: string | undefined,
): Promise<void> {
  const qrcodes = await getQRCodes(admin, shop);
  const qrCode = qrcodes.find((q) => q.id === id);

  if (!qrCode) {
    throw new Error("QR Code not found");
  }

  if (!qrCode.handle) {
    throw new Error("QR Code handle is missing");
  }

  const response = await admin.graphql(
    `#graphql
      mutation upsertQRCode($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
        metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
          metaobject {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        handle: { type: QR_CODE_METAOBJECT_TYPE, handle: qrCode.handle },
        metaobject: {
          fields: [{ key: "scans", value: String((qrCode.scans || 0) + 1) }],
        },
      },
    },
  );

  const data = await response.json();

  if (data.data.metaobjectUpsert.userErrors.length > 0) {
    throw new Error(data.data.metaobjectUpsert.userErrors[0].message);
  }
}
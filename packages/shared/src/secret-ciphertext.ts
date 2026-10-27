/**
 * The built-in block type that held an encrypted value in Blocks v8 content
 * before protocol 1.2 (`{ __resolveType: "secret", ciphertext }`). Content
 * holds no secrets now (they live in the deploy platform), but a site may
 * still carry one: Studio masks its ciphertext wherever it shows a diff.
 */
export const SECRET_BLOCK_TYPE = "secret";

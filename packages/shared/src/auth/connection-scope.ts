/**
 * Connection-wide role grants
 *
 * A role's per-connection entries (`{ "<connection-id>": [tools] }`) only
 * cover connections that existed when the role was saved. The reserved
 * `connections` key covers whole connections with the permission-list rules
 * (see ./permission-list): `["*"]` grants every tool on every connection,
 * including ones installed later, and `["*", "!<id>"]` does the same except
 * for one connection, which then grants nothing even if its own entry lists
 * tools.
 *
 * It never covers `self` (the Studio management tools).
 */
export const CONNECTION_SCOPE_KEY = "connections";

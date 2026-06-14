// telos owns its own DB schema (telos.goals), defined in @decocms/telos/postgres;
// mesh's runner just applies it. Nothing lands in Studio's public schema.
export { down, up } from "@decocms/telos/postgres";

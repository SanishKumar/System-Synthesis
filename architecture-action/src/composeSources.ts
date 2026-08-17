/**
 * Source resolution lives with the CLI, which the Action already depends on, so
 * both read a repository's history the same way. Re-exported here because this
 * is where the Action's tests and callers have always found it.
 */
export {
  EMPTY_COMPOSE,
  resolveComposeSources,
} from "@system-synthesis/architecture-cli";

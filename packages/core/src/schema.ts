/**
 * The JSON Schema pieces the config files share — `profiles.json` and `users.json`.
 *
 * **The parser's key lists come from here** (`schemaKeys`), so a field added to a schema and not to
 * its parser is an unknown-key error in the first test, not a page that edits a field `listen`
 * rejects. Every property carries a `title` (a label) and a `description` (one or two sentences a
 * person can act on); a test walks the whole tree and fails on a property without both.
 */

export interface SchemaNode {
  readonly title?: string;
  readonly description?: string;
  readonly type?: string | readonly string[];
  readonly enum?: readonly (string | number)[];
  readonly const?: number | string;
  readonly default?: unknown;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly minLength?: number;
  readonly minItems?: number;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: SchemaNode;
  readonly oneOf?: readonly SchemaNode[];
  readonly $ref?: string;
}

export const ID_PATTERN = '^[a-z0-9][a-z0-9_-]{0,39}$';
export const MCP_SERVER: SchemaNode = {
  type: 'object',
  title: 'MCP server',
  description: 'Passed to the agent unchanged in session/new. lotse reads only its name.',
  required: ['name'],
};

/** The keys an object node allows — what the parsers check for unknown keys. */
export function schemaKeys(node: SchemaNode): string[] {
  return Object.keys(node.properties ?? {});
}

/** The users file's shape as a JSON Schema. Same contract as `profile/schema.ts`. */

import { ID_PATTERN, type SchemaNode } from '../schema.ts';

export const USERS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'lotse users',
  description: 'The people `lotse listen` works for. Read once at start.',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'users'],
  properties: {
    version: { const: 1, title: 'Version', description: 'The file format. Always 1.' },
    users: {
      type: 'array',
      title: 'Users',
      description: 'The people questions go to. The first build serves one.',
      items: { $ref: '#/$defs/user' },
    },
  },
  $defs: {
    user: {
      type: 'object',
      title: 'User',
      description: 'A person questions go to.',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: {
          type: 'string',
          pattern: ID_PATTERN,
          title: 'Id',
          description: 'A short name, unique in the file. A profile names its user by it.',
        },
        addresses: {
          type: 'array',
          title: 'Addresses',
          description: 'Channel addresses of this person. The desktop channel needs none.',
          items: { type: 'string', title: 'Address', description: 'One channel address.' },
        },
      },
    },
  },
} as const satisfies SchemaNode & { $schema: string; $defs: Record<string, SchemaNode> };

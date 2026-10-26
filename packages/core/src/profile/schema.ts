/**
 * The profiles file's shape as a JSON Schema — one value a settings page, an editor and the parser all
 * read. Same contract as `users/schema.ts`: every property carries a `title` and a `description`, the
 * parser's key lists come from here, and what a schema cannot say (a duplicate id) stays in `profile.ts`.
 */

import { ID_PATTERN, MCP_SERVER, type SchemaNode } from '../schema.ts';

export const PROFILES_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'lotse profiles',
  description:
    'The profiles every lotse host shares — listen, the messenger, the widget and headless jobs. `listen` reads it at start.',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'profiles'],
  properties: {
    version: { const: 1, title: 'Version', description: 'The file format. Always 1.' },
    profiles: {
      type: 'array',
      title: 'Profiles',
      description: 'Who a session runs as: which agent, which model, which tools, how much it may do.',
      items: { $ref: '#/$defs/profile' },
    },
  },
  $defs: {
    profile: {
      type: 'object',
      title: 'Profile',
      description: 'An agent, a model and the tools and limits a session started under it gets.',
      additionalProperties: false,
      required: ['id', 'data'],
      properties: {
        id: {
          type: 'string',
          pattern: ID_PATTERN,
          title: 'Id',
          description: 'A short name, unique in the file. Tasks and requests name a profile by it.',
        },
        agent: {
          type: 'string',
          minLength: 1,
          title: 'Agent',
          description: 'A launcher id such as opencode. Empty: the agent lotse start would use.',
        },
        model: {
          type: 'string',
          minLength: 1,
          title: 'Model',
          description:
            "A model id the agent offers. Empty: lotse sends none and the agent's own default applies. A named model the agent does not offer stops the run.",
        },
        configOptions: {
          type: 'object',
          title: 'Config options',
          description:
            'Other options of the session, by the id the agent gives them: a thought level, a mode. A value is a string, or true or false for a switch. An option the agent does not offer stops the run.',
          additionalProperties: true,
        },
        mcpServers: {
          type: 'array',
          title: 'MCP servers',
          description:
            'Passed to the agent unchanged in session/new. A task or request that lists servers of its own uses those instead.',
          items: MCP_SERVER,
        },
        preamble: {
          type: 'string',
          minLength: 1,
          title: 'Preamble',
          description: 'Put in front of the first message of a new session.',
        },
        rights: {
          type: 'string',
          enum: ['read', 'confirm', 'released'],
          title: 'Rights limit',
          description:
            'The most a session under this profile may do, whatever a task asks for: read declines every permission request, confirm asks for each, released also allows the areas a task lists. Empty: no limit.',
        },
        user: {
          type: 'string',
          minLength: 1,
          title: 'User',
          description:
            "The id of the person in users.json this profile's questions go to. Empty: the only user there is.",
        },
        channels: {
          type: 'array',
          minItems: 1,
          title: 'Channels',
          description: 'The channels its messages may use. Leave it out for every active channel.',
          items: {
            type: 'string',
            enum: ['desktop', 'messenger'],
            title: 'Channel',
            description: 'A channel name as in channel.active in the settings file.',
          },
        },
        messengerDetail: {
          type: 'string',
          enum: ['full', 'notice'],
          default: 'full',
          title: 'Messenger detail',
          description:
            'full: the question itself goes to the chat. notice: only that a question waits, and where to read it.',
        },
        voice: {
          type: 'string',
          enum: ['any', 'local-only', 'off'],
          title: 'Voice',
          description:
            'Which speech engines a session on this profile may use. any: local and cloud. local-only: engines on this machine only. off: no speech. A host policy can only narrow it. Empty: no limit.',
        },
        data: {
          type: 'string',
          enum: ['private', 'public'],
          title: 'Data',
          description:
            'Whether sessions on this profile see private data. A label for you: listen notes a private profile on a free model at start and runs it all the same.',
        },
      },
    },
  },
} as const satisfies SchemaNode & { $schema: string; $defs: Record<string, SchemaNode> };

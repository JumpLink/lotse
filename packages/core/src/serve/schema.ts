/**
 * The task file's shape as a JSON Schema — one value a settings page, an editor and the parser all read.
 *
 * **The parser's key lists come from here** (`schemaKeys`), so a field added to the schema and not to
 * `parseServeConfig` is an unknown-key error in the first test, not a page that edits a field `serve`
 * rejects. Every property carries a `title` (a label) and a `description` (one or two sentences a person
 * can act on); a test walks the whole tree and fails on a property without both.
 *
 * The schema describes the shape. What it cannot say — a profile a task names exists, a released area
 * needs the `released` rights, exactly one of `prompt` and `promptFile` — stays in `config.ts`, and
 * `parseServeConfig` stays the authority on whether a file is valid.
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

const ID_PATTERN = '^[a-z0-9][a-z0-9_-]{0,39}$';
const DURATION_PATTERN = '^\\d+\\s*[mhd]$';

const MCP_SERVER: SchemaNode = {
  type: 'object',
  title: 'MCP server',
  description: 'Passed to the agent unchanged in session/new. lotse reads only its name.',
  required: ['name'],
};

const PROMPT = {
  prompt: {
    type: 'string',
    minLength: 1,
    title: 'Prompt',
    description: 'The text sent to the agent. Set this or a prompt file, not both.',
  },
  promptFile: {
    type: 'string',
    minLength: 1,
    title: 'Prompt file',
    description: 'A file holding the prompt, relative to the task file. Set this or a prompt, not both.',
  },
} as const satisfies Record<string, SchemaNode>;

/** Where a task's messages may go. On a profile for its tasks; a task can only narrow its profile. */
const DELIVERY = {
  channels: {
    type: 'array',
    minItems: 1,
    title: 'Channels',
    description:
      "The channels these messages may use. Leave it out for every active channel. A task's list can only narrow its profile's.",
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
      'full: the question itself goes to the chat. notice: only that a question waits in the task, and where to read it. Notice on the task or its profile wins; a task cannot loosen its profile.',
  },
} as const satisfies Record<string, SchemaNode>;

export const SERVE_CONFIG_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'lotse serve tasks',
  description: 'Users, profiles and the scheduled tasks `lotse serve` runs. Read once at start.',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'users', 'profiles', 'tasks'],
  properties: {
    version: { const: 1, title: 'Version', description: 'The file format. Always 1.' },
    users: {
      type: 'array',
      title: 'Users',
      description: 'The people serve works for. The first build serves one.',
      items: { $ref: '#/$defs/user' },
    },
    profiles: {
      type: 'array',
      title: 'Profiles',
      description: 'Who a task runs as, on which agent and model, and whether its data is private.',
      items: { $ref: '#/$defs/profile' },
    },
    tasks: {
      type: 'array',
      title: 'Tasks',
      description: 'What runs, when, with which tools and which rights.',
      items: { $ref: '#/$defs/task' },
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
          description: 'A short name, unique in the file.',
        },
        addresses: {
          type: 'array',
          title: 'Addresses',
          description: 'Channel addresses of this person. The desktop channel needs none.',
          items: { type: 'string', title: 'Address', description: 'One channel address.' },
        },
      },
    },
    profile: {
      type: 'object',
      title: 'Profile',
      description: 'An agent and a model a task runs on, and a label for the data it handles.',
      additionalProperties: false,
      required: ['id', 'user', 'data'],
      properties: {
        id: {
          type: 'string',
          pattern: ID_PATTERN,
          title: 'Id',
          description: 'A short name, unique in the file.',
        },
        user: { type: 'string', title: 'User', description: 'The id of the user this profile belongs to.' },
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
        data: {
          type: 'string',
          enum: ['private', 'public'],
          title: 'Data',
          description:
            'Whether the tasks on this profile see private data. A label for you: serve notes a private profile on a free model at start and runs it all the same.',
        },
        ...DELIVERY,
      },
    },
    precheck: {
      type: 'object',
      title: 'Precheck',
      description:
        'A cheaper turn before the task. It answers WORK or NOTHING on its last line; only WORK starts the task. It gets the read-only MCP servers and every permission request is declined.',
      additionalProperties: false,
      properties: {
        profile: {
          type: 'string',
          title: 'Profile',
          description:
            "The profile the precheck runs on. Empty: the task's agent with the agent's default model.",
        },
        ...PROMPT,
      },
    },
    task: {
      type: 'object',
      title: 'Task',
      description: 'One scheduled job.',
      additionalProperties: false,
      required: ['id', 'profile', 'schedule', 'cwd'],
      properties: {
        id: {
          type: 'string',
          pattern: ID_PATTERN,
          title: 'Id',
          description: 'A short name, unique in the file.',
        },
        profile: { type: 'string', title: 'Profile', description: 'The id of the profile the task runs on.' },
        schedule: {
          title: 'Schedule',
          description: 'An interval, or a time of day on chosen weekdays (local time).',
          oneOf: [
            {
              type: 'object',
              title: 'Every',
              description: 'Run at an interval.',
              additionalProperties: false,
              required: ['every'],
              properties: {
                every: {
                  type: 'string',
                  pattern: DURATION_PATTERN,
                  title: 'Interval',
                  description: 'A duration such as 30m, 2h or 1d; at least 1m.',
                },
              },
            },
            {
              type: 'object',
              title: 'At',
              description: 'Run at a time of day.',
              additionalProperties: false,
              required: ['at'],
              properties: {
                at: {
                  type: 'string',
                  pattern: '^\\d{1,2}:\\d{2}$',
                  title: 'Time',
                  description: 'HH:MM, local time.',
                },
                days: {
                  type: 'array',
                  title: 'Days',
                  description: 'The weekdays to run on. Empty: every day.',
                  items: {
                    type: 'string',
                    enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
                    title: 'Day',
                    description: 'A weekday.',
                  },
                },
              },
            },
          ],
        },
        ...PROMPT,
        cwd: {
          type: 'string',
          pattern: '^/',
          title: 'Working directory',
          description: 'An absolute path the session starts in.',
        },
        mcpServers: {
          type: 'array',
          title: 'MCP servers',
          description: 'The servers the first turn (and the precheck) may reach. Give it read-only ones.',
          items: MCP_SERVER,
        },
        answerMcpServers: {
          type: 'array',
          title: 'MCP servers after an answer',
          description:
            'The servers for the turn your answer starts, instead of the MCP servers. Empty: the same ones.',
          items: MCP_SERVER,
        },
        precheck: { $ref: '#/$defs/precheck' },
        rights: {
          type: 'string',
          enum: ['read', 'confirm', 'released'],
          default: 'confirm',
          title: 'Rights',
          description:
            'read declines every permission request, confirm asks you, released allows the listed areas.',
        },
        released: {
          type: 'array',
          title: 'Released areas',
          description: 'Tools allowed once per call without a question. Needs the released rights.',
          items: {
            type: 'object',
            title: 'Released area',
            description: 'A tool by its exact title, optionally narrowed by kind.',
            additionalProperties: false,
            required: ['tool'],
            properties: {
              tool: {
                type: 'string',
                minLength: 1,
                title: 'Tool',
                description: 'The exact tool title the agent sends.',
              },
              kind: {
                type: 'string',
                minLength: 1,
                title: 'Kind',
                description: 'The tool kind. Empty: any kind.',
              },
            },
          },
        },
        questions: {
          type: 'object',
          title: 'Question limits',
          description: 'A task at its ceiling is skipped before an agent starts.',
          additionalProperties: false,
          properties: {
            expiresIn: {
              type: 'string',
              pattern: DURATION_PATTERN,
              default: '12h',
              title: 'Expires in',
              description: 'How long a question stays open before it is cancelled.',
            },
            maxOpen: {
              type: 'integer',
              minimum: 1,
              default: 3,
              title: 'Most open',
              description: 'Open questions this task may have.',
            },
            maxPerHour: {
              type: 'integer',
              minimum: 1,
              default: 6,
              title: 'Most per hour',
              description: 'Questions this task may ask in one hour.',
            },
          },
        },
        notify: {
          type: 'string',
          enum: ['questions', 'always'],
          default: 'questions',
          title: 'Notify',
          description: "questions: only when the agent asks. always: also the run's final message.",
        },
        personNeeded: {
          type: 'object',
          title: 'Person needed',
          description:
            'Lets the task call person_needed when only you can go on (a login, a code, an approval). The run waits for your reply, or is deferred.',
          additionalProperties: false,
          properties: {
            enabled: {
              type: 'boolean',
              default: false,
              title: 'Enabled',
              description: 'Give the agent the person_needed tool for this task.',
            },
            timeoutMin: {
              type: 'integer',
              minimum: 1,
              title: 'Wait (minutes)',
              description: 'How long to wait for your reply. Empty: the default from the settings (30).',
            },
          },
        },
        ...DELIVERY,
      },
    },
  },
} as const satisfies SchemaNode & { $schema: string; $defs: Record<string, SchemaNode> };

/** The keys an object node allows — what `parseServeConfig` checks for unknown keys. */
export function schemaKeys(node: SchemaNode): string[] {
  return Object.keys(node.properties ?? {});
}

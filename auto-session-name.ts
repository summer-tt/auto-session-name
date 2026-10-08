/**
 * Auto Session Naming Extension
 *
 * After the first turn, this extension generates a short, descriptive
 * name for the session using a cheap available model.
 *
 * Only interactive runs (ctx.mode === "tui") name sessions. One-shot
 * modes (print/json/rpc, including implicitly piped runs) and
 * non-persisted sessions (--no-session) are skipped entirely, and an
 * already-named session is never renamed — so explicit --name (and
 * -c/-r on a named session) are respected for free.
 *
 * The naming model and request options can be overridden via a global config
 * file: ~/.pi/agent/auto-session-name.json
 *   { "provider": "google", "model": "gemma-4-26b-a4b-it", "temperature": 0.2,
 *     "thinking": "off" }
 *
 * Without a config file, the cheapest available model (respecting the
 * session's model scoping) is used; falling back to the active model. That
 * default pick is then written to the config file as a starting point for
 * user edits (an unusable file is regenerated; a file with a valid model has
 * only its invalid fields dropped, in place).
 *
 * Thinking defaults to off; the configured level is clamped to the model's
 * supported levels via pi-ai's clampThinkingLevel.
 */

import {
  clampThinkingLevel,
  type AnthropicOptions,
  type Api,
  type AzureOpenAIResponsesOptions,
  type GoogleApiThinkingLevel,
  type GoogleOptions,
  type GoogleVertexOptions,
  type Model,
  type OpenAICompletionsOptions,
  type OpenAIResponsesOptions,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_FILE = "auto-session-name.json";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
type ConfigThinkingLevel = (typeof THINKING_LEVELS)[number];

type NameConfig = {
  provider: string;
  model: string;
  temperature?: number;
  thinking?: ConfigThinkingLevel;
};

const sessionNamePrompt = (userMessage: string): string => {
  return [
    "Generate a short, descriptive, relevant title (between 3 and 8 words max) for an AI prompting session.",
    "Return only the title as a single line of plain text. Do not use Markdown formatting, quotation marks, labels, or explanations.",
    "Base the title on the following message:",
    `"${userMessage}"`,
  ].join("\n");
};

const normalizeSessionName = (raw: string): string => {
  let title = raw.trim();

  while (title) {
    const previous = title;
    title = title.replace(/^["']|["']$/g, "").trim();
    title = title.replace(/^\*+|\*+$/g, "").trim();

    const wrapped = title.match(/^(__|_|`{1,2}|~~)([^\r\n]*)\1$/u);
    if (wrapped) {
      const [, marker, inner] = wrapped;
      const edge = marker[0];
      // Exact boundary runs only: preserve fences and asymmetric wrappers.
      if (!inner.startsWith(edge) && !inner.endsWith(edge)) {
        title = inner.trim();
      }
    }

    if (title === previous) break;
  }

  return title;
};

type ConfigRead =
  | { status: "ok"; config: NameConfig }
  /** valid provider/model; malformed temperature/thinking fields were dropped */
  | { status: "repair"; config: NameConfig }
  /** missing or unusable; regenerate the whole file from the default pick */
  | { status: "regen" };

const configPath = (): string => join(getAgentDir(), CONFIG_FILE);

const writeConfigFile = (config: NameConfig, message: string): void => {
  try {
    writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
    console.warn(`[auto-session-name] ${message}`);
  } catch (err) {
    console.warn(`[auto-session-name] failed to write ${CONFIG_FILE}:`, err);
  }
};

/** Providers cap temperature (Anthropic 0-1, Google/OpenAI 0-2); 0-2 is the
 * widest valid range. Out-of-range values would be rejected by the API on
 * every naming run, so they are treated as malformed and repaired away. */
const isTemperature = (value: unknown): value is number =>
  typeof value === "number" && value >= 0 && value <= 2;
const isThinkingLevel = (value: unknown): value is ConfigThinkingLevel =>
  typeof value === "string" &&
  (THINKING_LEVELS as readonly string[]).includes(value);

/** Returns the field value when valid; warns and drops it otherwise. */
const readField = <T>(
  name: string,
  value: unknown,
  isValid: (v: unknown) => v is T,
  expectation: string,
): T | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (isValid(value)) {
    return value;
  }
  console.warn(
    `[auto-session-name] invalid ${CONFIG_FILE}: "${name}" ${expectation}; dropping it`,
  );
  return undefined;
};

const readConfig = (): ConfigRead => {
  let parsed: Partial<NameConfig>;
  try {
    parsed = JSON.parse(
      readFileSync(configPath(), "utf8"),
    ) as Partial<NameConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "regen" };
    }

    console.warn(
      `[auto-session-name] invalid ${CONFIG_FILE}, regenerating from default pick (${err})`,
    );
    return { status: "regen" };
  }

  if (
    typeof parsed.provider !== "string" ||
    parsed.provider.length === 0 ||
    typeof parsed.model !== "string" ||
    parsed.model.length === 0
  ) {
    console.warn(
      `[auto-session-name] invalid ${CONFIG_FILE}: expected { "provider": "...", "model": "...", "temperature"?: number, "thinking"?: "off" | "minimal" | ... | "max" }, regenerating from default pick`,
    );
    return { status: "regen" };
  }

  const config: NameConfig = {
    provider: parsed.provider,
    model: parsed.model,
  };
  const temperature = readField(
    "temperature",
    parsed.temperature,
    isTemperature,
    "must be a number between 0 and 2",
  );
  const thinking = readField(
    "thinking",
    parsed.thinking,
    isThinkingLevel,
    `must be one of ${THINKING_LEVELS.join(" | ")}`,
  );
  if (temperature !== undefined) {
    config.temperature = temperature;
  }

  if (thinking !== undefined) {
    config.thinking = thinking;
  }

  const dropped =
    (parsed.temperature !== undefined && temperature === undefined) ||
    (parsed.thinking !== undefined && thinking === undefined);

  return dropped ? { status: "repair", config } : { status: "ok", config };
};

/**
 * Generate a config pinning the model the default pick resolved to, so users
 * have a starting point to edit. Called when the file is missing or unusable
 * (no valid provider/model). A file with a valid provider/model is never
 * overwritten; malformed option fields are repaired in place instead.
 */
const writeDefaultConfig = (model: Model<Api>): void => {
  writeConfigFile(
    { provider: model.provider, model: model.id },
    `generated ${CONFIG_FILE} (provider "${model.provider}", model "${model.id}"). Edit it to change the naming model or request options`,
  );
};

const pickModel = (
  ctx: ExtensionContext,
  config: NameConfig | undefined,
): Model<Api> | undefined => {
  if (config) {
    const model = ctx.modelRegistry.find(config.provider, config.model);

    if (model && ctx.modelRegistry.hasConfiguredAuth(model)) {
      return model;
    }

    console.warn(
      `[auto-session-name] configured model ${config.provider}/${config.model} not found or not authenticated; using the default pick`,
    );
  }

  const pool =
    ctx.scopedModels.length > 0
      ? ctx.scopedModels.map((s) => s.model)
      : ctx.modelRegistry.getAvailable();
  if (pool.length > 0) {
    return [...pool].sort((a, b) => a.cost.input - b.cost.input)[0];
  }

  return ctx.model;
};

/** Per-API stream option shapes pi-ai's `complete()` accepts. */
type ApiOptions =
  | AnthropicOptions
  | GoogleOptions
  | GoogleVertexOptions
  | OpenAIResponsesOptions
  | OpenAICompletionsOptions
  | AzureOpenAIResponsesOptions
  | StreamOptions;

const OPENAI_APIS = [
  "openai-responses",
  "openai-completions",
  "azure-openai-responses",
] as const;

const isOpenAiApi = (api: Api): boolean =>
  (OPENAI_APIS as readonly string[]).includes(api);

/**
 * Build per-API request options for the naming call.
 *
 * - temperature: passed through as-is when configured; otherwise omitted
 *   (adapters guard provider-specific temperature support internally; note
 *   Anthropic drops it when thinking is enabled).
 * - thinking: defaults to "off". The configured level is clamped to the
 *   model's supported levels with pi-ai's clampThinkingLevel, so model
 *   capability and thinkingLevelMap overrides are respected. "off" disables
 *   thinking explicitly for reasoning-capable models (some APIs default
 *   reasoning on); unknown APIs disable by omission.
 */
const buildRequestOptions = (
  model: Model<Api>,
  config: NameConfig | undefined,
): ApiOptions => {
  const options: StreamOptions = {};

  if (config?.temperature !== undefined) {
    options.temperature = config.temperature;
  }

  const level = clampThinkingLevel(model, config?.thinking ?? "off");
  if (level === "off") {
    if (!model.reasoning) {
      return options;
    }

    switch (model.api) {
      case "anthropic-messages":
        return { ...options, thinkingEnabled: false };
      case "google-generative-ai":
      case "google-vertex":
        return { ...options, thinking: { enabled: false } };
      default:
        // OpenAI-family reasoning models default reasoning on; the raw
        // request path needs an explicit minimal effort to disable it.
        return isOpenAiApi(model.api)
          ? { ...options, reasoningEffort: "minimal" }
          : options;
    }
  }

  switch (model.api) {
    case "anthropic-messages":
      // Anthropic has no "minimal" effort
      return {
        ...options,
        thinkingEnabled: true,
        effort: level === "minimal" ? "low" : level,
      };
    case "google-generative-ai":
    case "google-vertex": {
      // Respect model-specific level mappings (e.g. gemma-4 maps medium to HIGH)
      const mapped = model.thinkingLevelMap?.[level];
      const googleLevel = (
        typeof mapped === "string" ? mapped : level
      ).toUpperCase() as GoogleApiThinkingLevel;

      return { ...options, thinking: { enabled: true, level: googleLevel } };
    }
    default:
      return isOpenAiApi(model.api)
        ? {
            ...options,
            reasoningEffort:
              level === "xhigh" || level === "max" ? "high" : level,
          }
        : options;
  }
};

const generateSessionName = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prompt: string,
) => {
  try {
    const read = readConfig();

    const config = read.status === "regen" ? undefined : read.config;
    const model = pickModel(ctx, config);

    if (!model) {
      console.warn(
        "[auto-session-name] no model available; skipping session naming",
      );
      return;
    }
    if (read.status === "regen") {
      writeDefaultConfig(model);
    } else if (read.status === "repair") {
      // Keep the user's model choice; rewrite without the invalid fields only
      writeConfigFile(
        read.config,
        `rewrote ${CONFIG_FILE} without invalid fields (provider "${read.config.provider}", model "${read.config.model}" kept)`,
      );
    }

    const response = await ctx.modelRegistry.complete(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: sessionNamePrompt(prompt) }],
            timestamp: Date.now(),
          },
        ],
      },
      // opencode gateways reject a request without a session id (400
      // MissingSessionID); pi-ai derives x-opencode-session from this option.
      {
        ...buildRequestOptions(model, config),
        sessionId: ctx.sessionManager?.getSessionId?.(),
      },
    );

    // Model output is untrusted: keep text blocks and normalize title boundaries
    const rawTitle = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
    const title = normalizeSessionName(rawTitle);

    if (title) {
      pi.setSessionName(title);
    }
  } catch (err) {
    console.warn("[auto-session-name] failed to generate session name:", err);
  }
};

/**
 * /reload re-runs the extension; the getSessionName() guard prevents a second
 * naming run (pi does not set a session name by default)
 */
export default function (pi: ExtensionAPI) {
  let startPrompt: string | undefined;
  let isSessionNamed = false;

  // Interactive gating happens in agent_end (ctx.mode); /new or /fork starts
  // a fresh interactive session, so reset the one-name-per-fresh-session guard.
  pi.on("session_start", (event) => {
    if (event.reason !== "new" && event.reason !== "fork") return;

    startPrompt = undefined;
    isSessionNamed = false;
  });

  // Excludes any skill invocation at session start
  pi.on("before_agent_start", (event) => {
    if (!startPrompt) {
      startPrompt = event.prompt;
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (!startPrompt) return;
    if (isSessionNamed) return;
    if (pi.getSessionName()) return;
    // --no-session runs use an in-memory session: no file until the first
    // persisted write, which only persisted sessions ever perform
    if (ctx.sessionManager.getSessionFile() === undefined) return;

    isSessionNamed = true;

    // The session outlives the turn, so run naming in the background
    // without delaying the user's prompt. The call never rejects (it catches
    // internally). Edge: quitting or switching sessions within the ~1-2s
    // naming window loses the name (warned, cosmetic).
    void generateSessionName(pi, ctx, startPrompt);
  });
}

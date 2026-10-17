/**
 * Auto Session Naming Extension
 *
 * On the first eligible user run, this extension starts generating a short,
 * descriptive session name using a cheap available model. Work is deferred
 * until after before_agent_start returns; the naming response is not awaited.
 * An explicit name set while the request is in flight aborts the request and
 * is never replaced by the generated name.
 *
 * Only interactive runs (ctx.mode === "tui") name sessions. One-shot
 * modes (print/json/rpc, including implicitly piped runs) and
 * non-persisted sessions (--no-session) are skipped entirely, and an
 * already-named session is never renamed — so explicit --name (and
 * -c/-r on a named session) are respected for free.
 *
 * The naming model and request options can be overridden via a global config
 * file: ~/.pi/agent/pi-auto-rename.json
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
  isRetryableAssistantError,
  isContextOverflow,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_FILE = "pi-auto-rename.json";

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

// One task per extension lifecycle. A reload/resume may start a fresh task.
const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 20_000;
const TASK_DEADLINE_MS = 60_000;
const BASE_DELAY_MS = 1_000;

type TaskState = "idle" | "running" | "waiting-retry" | "named" | "failed" | "cancelled";
type NamingTask = {
  state: TaskState;
  sessionId: string;
  sessionFile: string;
  prompt: string;
  controller: AbortController;
  attempt?: AbortController;
  deferTimer?: ReturnType<typeof setTimeout>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  stopListening?: () => void;
  deadline: number;
  expired: boolean;
};

class NamingInterrupted extends Error {
  readonly kind: "cancelled" | "timeout";
  constructor(kind: "cancelled" | "timeout") {
    super(kind);
    this.kind = kind;
  }
}

// Do not log provider text: it may echo credentials or the original prompt.
// Categories are deliberately fixed strings, not truncated untrusted messages.
const errorCategory = (message: string): string => {
  if (/insufficient_quota|quota.?exceeded|billing|out of budget|usage.limit|available balance/i.test(message)) return "quota/billing limit";
  if (/unsupported_value|invalid_request|bad request|unsupported parameter|model.not.found|no api key|unauthorized|forbidden|authentication/i.test(message)) return "invalid request/auth/model";
  // Only explicit status formats count. A parameter value such as <= 500 is
  // not a status code. Known permanent errors override the SDK's heuristics.
  if (/(?:^\s*|HTTP\s+|status(?:\s+code)?\s*[:=]?\s*)(?:400|401|402|403|404|405|413|422)\b/i.test(message) ||
      /\((?:400|401|402|403|404|405|413|422)\)/.test(message)) return "permanent HTTP error";
  return "provider/transport error";
};

const retryableResponse = (response: AssistantMessage): boolean =>
  !isContextOverflow(response) &&
  errorCategory(response.errorMessage ?? "") === "provider/transport error" &&
  isRetryableAssistantError(response);

// A local race enforces the bound even when a provider ignores abort. Both
// branches of the original Promise remain handled after this wait finishes.
const boundedAttempt = async (
  task: NamingTask,
  produce: (signal: AbortSignal) => Promise<AssistantMessage>,
): Promise<AssistantMessage> => {
  const controller = new AbortController();
  task.attempt = controller;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onCancel: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    onCancel = () => {
      reject(new NamingInterrupted("cancelled"));
      controller.abort();
    };
    task.controller.signal.addEventListener("abort", onCancel, { once: true });
    if (task.controller.signal.aborted) {
      onCancel();
      return;
    }
    timer = setTimeout(() => {
      // Settle the local timeout before abort can reject the transport.
      reject(new NamingInterrupted("timeout"));
      controller.abort();
    }, Math.max(0, Math.min(ATTEMPT_TIMEOUT_MS, task.deadline - Date.now())));
  });
  try {
    if (task.controller.signal.aborted) throw new NamingInterrupted("cancelled");
    return await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new NamingInterrupted("cancelled");
      return produce(controller.signal);
    }), interrupted]);
  } finally {
    clearTimeout(timer);
    task.controller.signal.removeEventListener("abort", onCancel);
    if (task.attempt === controller) task.attempt = undefined;
  }
};

const backoff = (task: NamingTask, delay: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const onCancel = () => {
      clearTimeout(timer);
      task.controller.signal.removeEventListener("abort", onCancel);
      reject(new NamingInterrupted("cancelled"));
    };
    const timer = setTimeout(() => {
      task.controller.signal.removeEventListener("abort", onCancel);
      resolve();
    }, delay);
    task.controller.signal.addEventListener("abort", onCancel, { once: true });
    if (task.controller.signal.aborted) onCancel();
  });

export default function (pi: ExtensionAPI) {
  let active: NamingTask | undefined;

  const cleanup = (task: NamingTask) => {
    clearTimeout(task.deferTimer);
    clearTimeout(task.deadlineTimer);
    task.stopListening?.();
    task.stopListening = undefined;
  };
  const cancel = (task: NamingTask) => {
    if (task.state === "named" || task.state === "failed" || task.state === "cancelled") return;
    task.state = "cancelled"; // Invalidate locally before touching runtime resources.
    task.controller.abort();
    cleanup(task);
  };
  const current = (task: NamingTask, ctx: ExtensionContext): boolean => {
    // Never touch a disposed extension API just to discover that it is stale.
    if (active !== task || task.controller.signal.aborted ||
        task.state === "cancelled" || task.state === "failed" || task.state === "named") return false;
    if (Date.now() >= task.deadline) {
      task.expired = true;
      task.controller.abort();
      return false;
    }
    if (ctx.sessionManager.getSessionId() !== task.sessionId ||
        ctx.sessionManager.getSessionFile() !== task.sessionFile || pi.getSessionName()) {
      cancel(task);
      return false;
    }
    return true;
  };

  const run = async (task: NamingTask, ctx: ExtensionContext) => {
    let label = "unselected model";
    const warn = (reason: string) => console.warn(
      `[auto-session-name] failed to generate session name (${label}): ${reason}. Fix configuration if needed, /reload, then send a user prompt to try again`,
    );
    try {
      if (!current(task, ctx)) return;
      // Configuration and model selection happen once, behind the initial defer.
      const read = readConfig();
      const config = read.status === "regen" ? undefined : read.config;
      const model = pickModel(ctx, config);
      if (!model) {
        warn("no model available");
        task.state = "failed";
        return;
      }
      label = `${model.provider}/${model.id}`;
      if (read.status === "regen") writeDefaultConfig(model);
      else if (read.status === "repair") {
        writeConfigFile(read.config, `rewrote ${CONFIG_FILE} without invalid fields`);
      }
      const level = clampThinkingLevel(model, config?.thinking ?? "off");
      const options = {
        temperature: config?.temperature,
        reasoning: level === "off" ? undefined : level,
        sessionId: task.sessionId,
        maxRetries: 0,
      };
      const context = {
        messages: [{
          role: "user" as const,
          content: [{ type: "text" as const, text: sessionNamePrompt(task.prompt) }],
          timestamp: Date.now(),
        }],
      };
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (!current(task, ctx)) return;
        task.state = "running";
        let retry = false;
        let reason = "provider/transport error";
        try {
          const response = await boundedAttempt(task, (signal) =>
            ctx.modelRegistry.streamSimple(model, context, { ...options, signal }).result(),
          );
          if (!current(task, ctx)) return;
          if (response.stopReason === "error") {
            reason = isContextOverflow(response) ? "context overflow" : errorCategory(response.errorMessage ?? "");
            retry = retryableResponse(response);
          } else if (response.stopReason !== "stop") {
            // Unexpected provider aborts and incomplete outputs are observable.
            reason = response.stopReason === "aborted" ? "unexpected provider abort" : "incomplete response";
          } else {
            const raw = response.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text).join("");
            const title = normalizeSessionName(raw);
            if (title) {
              if (!current(task, ctx)) return;
              task.stopListening?.();
              task.stopListening = undefined;
              pi.setSessionName(title);
              task.state = "named";
              return;
            }
            reason = "empty title";
          }
        } catch (error) {
          if (task.controller.signal.aborted || active !== task) return;
          if (error instanceof NamingInterrupted && error.kind === "timeout") {
            reason = "request timeout";
            retry = true;
          } else {
            // Unknown thrown/programming errors are not safely retryable.
            reason = "request exception";
          }
        }
        if (!current(task, ctx)) return;
        if (!retry || attempt === MAX_ATTEMPTS) {
          warn(`${reason}; attempts ${attempt}/${MAX_ATTEMPTS}`);
          task.state = "failed";
          return;
        }
        const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
        task.state = "waiting-retry";
        console.warn(`[auto-session-name] ${label}: attempt ${attempt}/${MAX_ATTEMPTS} failed (${reason}); retry in ${delay}ms`);
        await backoff(task, delay);
      }
    } catch {
      if (!task.controller.signal.aborted && active === task) {
        warn("unexpected naming exception");
        task.state = "failed";
      }
    } finally {
      if (task.expired && active === task && task.state !== "cancelled") {
        warn("task deadline exceeded");
        task.state = "failed";
      }
      cleanup(task);
    }
  };

  pi.on("session_shutdown", () => {
    if (active) cancel(active);
  });
  pi.on("session_start", () => {
    if (active) cancel(active);
    active = undefined;
  });
  pi.on("before_agent_start", (event, ctx) => {
    if ("messageType" in event && event.messageType !== "user") return;
    if (!event.prompt || ctx.mode !== "tui" || active || pi.getSessionName()) return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile === undefined) return;
    if (typeof ctx.modelRegistry.streamSimple !== "function") {
      console.warn("[auto-session-name] naming requires a host with modelRegistry.streamSimple (tested on Pi 1.3.0)");
      return;
    }
    const task: NamingTask = {
      state: "idle",
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile,
      prompt: event.prompt,
      controller: new AbortController(),
      deadline: Date.now() + TASK_DEADLINE_MS,
      expired: false,
    };
    active = task;
    // Cover the initial defer and all backoffs, not only an in-flight request.
    task.stopListening = pi.on("session_info_changed", () => cancel(task));
    task.deadlineTimer = setTimeout(() => {
      task.expired = true;
      task.controller.abort();
    }, TASK_DEADLINE_MS);
    task.deferTimer = setTimeout(() => { void run(task, ctx); }, 0);
  });
}

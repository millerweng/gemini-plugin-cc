// Gemini ACP protocol types.
// Confirmed against gemini-cli 0.39.0-preview.0 via `gemini --acp` stdin/stdout probes.
// Zed's Agent-Client Protocol v1: https://github.com/zed-industries/agent-client-protocol
//
// API stability: method names are tracked by the ACP_METHODS table at the top of
// acp-client.mjs. If Gemini renames methods between releases, edit that table.

export type ProtocolVersion = 1;

export interface ClientFsCapabilities {
  readTextFile: boolean;
  writeTextFile: boolean;
}

export interface ClientCapabilities {
  fs?: ClientFsCapabilities;
}

export interface InitializeParams {
  protocolVersion: ProtocolVersion;
  clientCapabilities?: ClientCapabilities;
}

export interface AuthMethodMeta {
  [key: string]: unknown;
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
  _meta?: AuthMethodMeta;
}

export interface AgentInfo {
  name: string;
  title?: string;
  version?: string;
}

export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export interface McpCapabilities {
  http?: boolean;
  sse?: boolean;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: PromptCapabilities;
  mcpCapabilities?: McpCapabilities;
}

export interface InitializeResult {
  protocolVersion: ProtocolVersion;
  authMethods: AuthMethod[];
  agentInfo: AgentInfo;
  agentCapabilities: AgentCapabilities;
}

export interface AuthenticateParams {
  methodId: string;
}

export type AuthenticateResult = Record<string, never>;

export interface NewSessionParams {
  cwd: string;
  mcpServers?: unknown[];
  modelId?: string | null;
}

export interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

export interface SessionModes {
  availableModes: SessionMode[];
  currentModeId: string;
}

export interface SessionModel {
  modelId: string;
  name: string;
  description?: string;
}

export interface SessionModels {
  availableModels: SessionModel[];
  currentModelId: string;
}

export interface NewSessionResult {
  sessionId: string;
  modes?: SessionModes;
  models?: SessionModels;
}

export interface LoadSessionParams {
  sessionId: string;
  cwd: string;
  mcpServers?: unknown[];
  modelId?: string | null;
}

export type LoadSessionResult = NewSessionResult;

export interface ContentBlockText {
  type: "text";
  text: string;
}

export type PromptContentBlock = ContentBlockText;

export interface PromptParams {
  sessionId: string;
  prompt: PromptContentBlock[];
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "refusal"
  | "cancelled"
  | "error"
  | string;

export interface PromptResult {
  stopReason: StopReason;
}

export interface CancelParams {
  sessionId: string;
}

export interface SetSessionModeParams {
  sessionId: string;
  modeId: string;
}

export interface SetSessionModelParams {
  sessionId: string;
  modelId: string;
}

// session/update notification payload kinds (Gemini-observed).
export type SessionUpdateKind =
  | "agent_message_chunk"
  | "agent_thought_chunk"
  | "tool_call"
  | "tool_call_update"
  | "plan"
  | "user_message_chunk"
  | "available_commands_update"
  | string;

export interface SessionUpdateToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed" | string;
  content?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface SessionUpdatePayload {
  sessionUpdate: SessionUpdateKind;
  content?: { type: string; text?: string; [key: string]: unknown };
  text?: string;
  thought?: string;
  toolCall?: SessionUpdateToolCall;
  plan?: unknown;
  availableCommands?: unknown[];
  [key: string]: unknown;
}

export interface SessionUpdateNotification {
  method: "session/update";
  params: {
    sessionId: string;
    update: SessionUpdatePayload;
  };
}

export type AcpNotification = SessionUpdateNotification;
export type AcpNotificationHandler = (message: AcpNotification) => void;

export interface AcpClientOptions {
  env?: NodeJS.ProcessEnv;
  clientCapabilities?: ClientCapabilities;
  brokerEndpoint?: string;
  disableBroker?: boolean;
  reuseExistingBroker?: boolean;
}

export interface AcpMethodMap {
  initialize: { params: InitializeParams; result: InitializeResult };
  authenticate: { params: AuthenticateParams; result: AuthenticateResult };
  "session/new": { params: NewSessionParams; result: NewSessionResult };
  "session/load": { params: LoadSessionParams; result: LoadSessionResult };
  "session/prompt": { params: PromptParams; result: PromptResult };
  "session/cancel": { params: CancelParams; result: Record<string, never> };
  "session/set_mode": { params: SetSessionModeParams; result: Record<string, never> };
  "session/set_model": { params: SetSessionModelParams; result: Record<string, never> };
}

export type AcpMethod = keyof AcpMethodMap;
export type AcpRequestParams<M extends AcpMethod> = AcpMethodMap[M]["params"];
export type AcpResponse<M extends AcpMethod> = AcpMethodMap[M]["result"];

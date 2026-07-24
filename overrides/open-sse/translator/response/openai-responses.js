/**
 * Translator: OpenAI Chat Completions → OpenAI Responses API (response)
 * Converts streaming chunks from Chat Completions to Responses API events
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { buildChunk } from "../concerns/chunk.js";
import { buildUsage } from "../concerns/usage.js";
import { fallbackToolCallId } from "../concerns/toolCall.js";
import { reasoningDelta, extractReasoningText } from "../concerns/reasoning.js";
import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM, OPENAI_FINISH, MODEL_FALLBACK } from "../schema/index.js";

/**
 * Translate OpenAI chunk to Responses API events
 * @returns {Array} Array of events with { event, data } structure
 */
export function openaiToOpenAIResponsesResponse(chunk, state) {
  if (!chunk) {
    return flushEvents(state);
  }

  if (!chunk.choices?.length) return [];

  const events = [];
  const nextSeq = () => ++state.seq;

  const emit = (eventType, data) => {
    data.sequence_number = nextSeq();
    events.push({ event: eventType, data });
  };

  const choice = chunk.choices[0];
  const idx = choice.index || 0;
  const delta = choice.delta || {};

  // Emit initial events
  if (!state.started) {
    state.started = true;
    state.responseId = chunk.id ? `resp_${chunk.id}` : state.responseId;

    emit("response.created", {
      type: "response.created",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "in_progress",
        background: false,
        error: null,
        output: []
      }
    });

    emit("response.in_progress", {
      type: "response.in_progress",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "in_progress"
      }
    });
  }

  // Handle reasoning across vendor shapes (reasoning_content / reasoning / reasoning_details)
  const reasoningText = extractReasoningText(delta);
  if (reasoningText) {
    startReasoning(state, emit, idx);
    emitReasoningDelta(state, emit, reasoningText);
  }

  // Handle text content
  if (delta.content) {
    let content = delta.content;

    if (content.includes("<think>")) {
      state.inThinking = true;
      content = content.replace("<think>", "");
      startReasoning(state, emit, idx);
    }

    if (content.includes("</think>")) {
      const parts = content.split("</think>");
      const thinkPart = parts[0];
      const textPart = parts.slice(1).join("</think>");
      if (thinkPart) emitReasoningDelta(state, emit, thinkPart);
      closeReasoning(state, emit);
      state.inThinking = false;
      content = textPart;
    }

    if (state.inThinking && content) {
      emitReasoningDelta(state, emit, content);
      return events;
    }

    if (content) {
      emitTextContent(state, emit, idx, content);
    }
  }

  // Handle tool_calls
  if (delta.tool_calls) {
    closeMessage(state, emit, idx);
    for (const tc of delta.tool_calls) {
      emitToolCall(state, emit, tc);
    }
  }

  // Handle finish_reason
  if (choice.finish_reason) {
    for (const i in state.msgItemAdded) closeMessage(state, emit, i);
    closeReasoning(state, emit);
    for (const i in state.toolCallStates) closeToolCall(state, emit, i);
    sendCompleted(state, emit);
  }

  return events;
}

// Helper functions
function allocateOutputIndex(state) {
  const outputIndex = state.nextOutputIndex ?? 0;
  state.nextOutputIndex = outputIndex + 1;
  return outputIndex;
}

function startReasoning(state, emit, idx) {
  if (!state.reasoningId) {
    state.reasoningIndex = allocateOutputIndex(state);
    state.reasoningId = `rs_${state.responseId}_${state.reasoningIndex}`;

    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: state.reasoningIndex,
      item: { id: state.reasoningId, type: RESPONSES_ITEM.REASONING, summary: [] }
    });

    emit("response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      part: { type: RESPONSES_ITEM.SUMMARY_TEXT, text: "" }
    });
    state.reasoningPartAdded = true;
  }
}

function emitReasoningDelta(state, emit, text) {
  if (!text) return;
  state.reasoningBuf += text;
  emit("response.reasoning_summary_text.delta", {
    type: "response.reasoning_summary_text.delta",
    item_id: state.reasoningId,
    output_index: state.reasoningIndex,
    summary_index: 0,
    delta: text
  });
}

function closeReasoning(state, emit) {
  if (state.reasoningId && !state.reasoningDone) {
    state.reasoningDone = true;

    emit("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      text: state.reasoningBuf
    });

    emit("response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      part: { type: RESPONSES_ITEM.SUMMARY_TEXT, text: state.reasoningBuf }
    });

    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: state.reasoningIndex,
      item: {
        id: state.reasoningId,
        type: RESPONSES_ITEM.REASONING,
        summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: state.reasoningBuf }]
      }
    });
  }
}

function emitTextContent(state, emit, idx, content) {
  if (state.messageOutputIndexes[idx] === undefined) {
    state.messageOutputIndexes[idx] = allocateOutputIndex(state);
  }
  const outputIndex = state.messageOutputIndexes[idx];
  const msgId = `msg_${state.responseId}_${outputIndex}`;

  if (!state.msgItemAdded[idx]) {
    state.msgItemAdded[idx] = true;

    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { id: msgId, type: RESPONSES_ITEM.MESSAGE, content: [], role: ROLE.ASSISTANT }
    });
  }

  if (!state.msgContentAdded[idx]) {
    state.msgContentAdded[idx] = true;

    emit("response.content_part.added", {
      type: "response.content_part.added",
      item_id: msgId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: RESPONSES_ITEM.OUTPUT_TEXT, annotations: [], logprobs: [], text: "" }
    });
  }

  emit("response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: msgId,
    output_index: outputIndex,
    content_index: 0,
    delta: content,
    logprobs: []
  });

  if (!state.msgTextBuf[idx]) state.msgTextBuf[idx] = "";
  state.msgTextBuf[idx] += content;
}

function closeMessage(state, emit, idx) {
  if (state.msgItemAdded[idx] && !state.msgItemDone[idx]) {
    state.msgItemDone[idx] = true;
    const fullText = state.msgTextBuf[idx] || "";
    const outputIndex = state.messageOutputIndexes[idx];
    const msgId = `msg_${state.responseId}_${outputIndex}`;

    emit("response.output_text.done", {
      type: "response.output_text.done",
      item_id: msgId,
      output_index: outputIndex,
      content_index: 0,
      text: fullText,
      logprobs: []
    });

    emit("response.content_part.done", {
      type: "response.content_part.done",
      item_id: msgId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: RESPONSES_ITEM.OUTPUT_TEXT, annotations: [], logprobs: [], text: fullText }
    });

    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: {
        id: msgId,
        type: RESPONSES_ITEM.MESSAGE,
        content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, annotations: [], logprobs: [], text: fullText }],
        role: ROLE.ASSISTANT
      }
    });
  }
}

function ensureToolCallState(state, toolCallIndex) {
  if (!state.toolCallStates[toolCallIndex]) {
    state.toolCallStates[toolCallIndex] = {
      toolCallIndex,
      outputIndex: allocateOutputIndex(state),
      callId: "",
      name: "",
      arguments: "",
      emittedArgumentsLength: 0,
      added: false,
      done: false,
      identity: null,
      itemId: "",
      customInput: "",
      customInputEmitted: false,
    };
  }
  return state.toolCallStates[toolCallIndex];
}

function resolveToolIdentity(state, wireName, allowFallback = false) {
  const identity = state.responsesToolState?.toolIdentities?.[wireName];
  if (identity) return identity;
  if (!state.responsesToolState || allowFallback) {
    return { kind: RESPONSES_ITEM.FUNCTION_CALL, name: wireName || "_unknown", childType: "function" };
  }
  return null;
}

function safeParseToolSearchArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const raw = typeof value === "string" ? value : "";
  try {
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return raw.trim() ? { query: raw } : {};
  }
}

function parseCustomInput(value) {
  const raw = typeof value === "string" ? value : "";
  try {
    const parsed = JSON.parse(raw || "{}");
    if (typeof parsed === "string") return parsed;
    if (typeof parsed?.input === "string") return parsed.input;
  } catch {
    // A provider may send the custom input directly instead of JSON-wrapping it.
  }
  return raw;
}

function itemIdPrefix(identity) {
  if (identity.kind === RESPONSES_ITEM.TOOL_SEARCH) return "ts";
  if (identity.kind === RESPONSES_ITEM.CUSTOM_TOOL_CALL) return "ct";
  return "fc";
}

function buildToolItem(record, status, complete) {
  const identity = record.identity;
  const base = {
    id: record.itemId,
    call_id: record.callId,
    status,
  };

  if (identity.kind === RESPONSES_ITEM.TOOL_SEARCH) {
    return {
      ...base,
      type: RESPONSES_ITEM.TOOL_SEARCH_CALL,
      execution: "client",
      arguments: complete ? safeParseToolSearchArguments(record.arguments) : {},
    };
  }

  if (identity.kind === RESPONSES_ITEM.CUSTOM_TOOL_CALL) {
    return {
      ...base,
      type: RESPONSES_ITEM.CUSTOM_TOOL_CALL,
      name: identity.name,
      ...(identity.namespace ? { namespace: identity.namespace } : {}),
      input: complete ? record.customInput : "",
    };
  }

  return {
    ...base,
    type: RESPONSES_ITEM.FUNCTION_CALL,
    name: identity.name,
    ...(identity.namespace ? { namespace: identity.namespace } : {}),
    arguments: complete ? record.arguments : "",
  };
}

function responseToolItem(toolCall, responsesToolState) {
  const fn = toolCall?.function || {};
  const wireName = fn.name || toolCall?.name || "_unknown";
  const callId = toolCall?.id || fallbackToolCallId();
  const identity = responsesToolState?.toolIdentities?.[wireName] || {
    kind: RESPONSES_ITEM.FUNCTION_CALL,
    name: wireName,
    childType: "function",
  };
  const argumentsValue =
    typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {});
  const record = {
    identity,
    itemId: `${itemIdPrefix(identity)}_${callId}`,
    callId,
    arguments: argumentsValue,
    customInput: parseCustomInput(argumentsValue),
  };
  return buildToolItem(record, "completed", true);
}

function responseUsage(usage) {
  const inputTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  const result = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: usage?.total_tokens ?? inputTokens + outputTokens,
  };
  if (usage?.prompt_tokens_details || usage?.input_tokens_details) {
    result.input_tokens_details = usage.prompt_tokens_details || usage.input_tokens_details;
  }
  if (usage?.completion_tokens_details || usage?.output_tokens_details) {
    result.output_tokens_details = usage.completion_tokens_details || usage.output_tokens_details;
  }
  return result;
}

/**
 * Convert one non-streaming Chat Completions response into Responses JSON.
 * The request-scoped identity map restores native and namespaced tool types.
 */
export function openAICompletionToOpenAIResponsesResponse(responseBody, responsesToolState) {
  const choice = responseBody?.choices?.[0];
  if (!choice) return responseBody;

  const message = choice.message || {};
  const output = [];
  const responseId = String(responseBody.id || `chatcmpl-${Date.now()}`);
  const createdAt = responseBody.created || Math.floor(Date.now() / 1000);
  const text = typeof message.content === "string" ? message.content : "";
  const reasoning = message.reasoning_content || message.provider_specific_fields?.reasoning_content || "";

  if (reasoning) {
    output.push({
      id: `rs_resp_${responseId}_${output.length}`,
      type: RESPONSES_ITEM.REASONING,
      summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning }],
    });
  }
  if (text) {
    output.push({
      id: `msg_resp_${responseId}_${output.length}`,
      type: RESPONSES_ITEM.MESSAGE,
      status: "completed",
      role: ROLE.ASSISTANT,
      content: [{
        type: RESPONSES_ITEM.OUTPUT_TEXT,
        annotations: [],
        logprobs: [],
        text,
      }],
    });
  }
  for (const toolCall of message.tool_calls || []) {
    output.push(responseToolItem(toolCall, responsesToolState));
  }

  return {
    id: responseId.startsWith("resp_") ? responseId : `resp_${responseId}`,
    object: "response",
    created_at: createdAt,
    status: "completed",
    model: responseBody.model || "unknown",
    output,
    usage: responseUsage(responseBody.usage),
  };
}

function startToolCall(state, emit, record, allowFallback = false) {
  if (record.added || !record.callId || !record.name) return false;
  const identity = resolveToolIdentity(state, record.name, allowFallback);
  if (!identity) return false;

  record.identity = identity;
  record.itemId = `${itemIdPrefix(identity)}_${record.callId}`;
  if (identity.kind === RESPONSES_ITEM.CUSTOM_TOOL_CALL) {
    record.customInput = parseCustomInput(record.arguments);
  }
  record.added = true;

  emit("response.output_item.added", {
    type: "response.output_item.added",
    output_index: record.outputIndex,
    item: buildToolItem(record, "in_progress", identity.kind === RESPONSES_ITEM.TOOL_SEARCH),
  });
  return true;
}

function emitPendingToolInput(state, emit, record) {
  if (!record.added || !record.identity) return;

  if (record.identity.kind === RESPONSES_ITEM.FUNCTION_CALL) {
    const delta = record.arguments.slice(record.emittedArgumentsLength);
    if (!delta) return;
    emit("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: record.itemId,
      output_index: record.outputIndex,
      delta,
    });
    record.emittedArgumentsLength = record.arguments.length;
    return;
  }

  if (
    record.identity.kind === RESPONSES_ITEM.CUSTOM_TOOL_CALL &&
    !record.customInputEmitted &&
    record.customInput
  ) {
    emit("response.custom_tool_call_input.delta", {
      type: "response.custom_tool_call_input.delta",
      item_id: record.itemId,
      output_index: record.outputIndex,
      delta: record.customInput,
    });
    record.customInputEmitted = true;
  }
}

function emitToolCall(state, emit, tc) {
  const record = ensureToolCallState(state, tc.index ?? 0);
  if (tc.id && !record.callId) record.callId = tc.id;
  if (tc.function?.name) record.name += tc.function.name;
  if (tc.function?.arguments) record.arguments += tc.function.arguments;

  const identity = resolveToolIdentity(state, record.name);
  if (!state.responsesToolState && identity?.kind === RESPONSES_ITEM.FUNCTION_CALL) {
    startToolCall(state, emit, record);
    emitPendingToolInput(state, emit, record);
  }
}

function closeToolCall(state, emit, idx) {
  const record = ensureToolCallState(state, idx);
  if (record.done || (!record.callId && !record.name && !record.arguments)) return;
  if (!record.callId) record.callId = fallbackToolCallId();
  if (!record.name) record.name = "_unknown";
  startToolCall(state, emit, record, true);
  if (!record.added) return;

  emitPendingToolInput(state, emit, record);

  if (record.identity.kind === RESPONSES_ITEM.FUNCTION_CALL) {
    emit("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: record.itemId,
      output_index: record.outputIndex,
      arguments: record.arguments || "{}",
    });
  } else if (record.identity.kind === RESPONSES_ITEM.CUSTOM_TOOL_CALL) {
    emit("response.custom_tool_call_input.done", {
      type: "response.custom_tool_call_input.done",
      item_id: record.itemId,
      output_index: record.outputIndex,
      input: record.customInput,
    });
  }

  emit("response.output_item.done", {
    type: "response.output_item.done",
    output_index: record.outputIndex,
    item: buildToolItem(record, "completed", true),
  });

  record.done = true;
  state.funcCallIds[idx] = record.callId;
  state.funcNames[idx] = record.name;
  state.funcArgsBuf[idx] = record.arguments;
  state.funcItemDone[idx] = true;
  state.funcArgsDone[idx] = true;
}

function sendCompleted(state, emit) {
  if (!state.completedSent) {
    state.completedSent = true;
    emit("response.completed", {
      type: "response.completed",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "completed",
        background: false,
        error: null
      }
    });
  }
}

function flushEvents(state) {
  if (state.completedSent) return [];

  const events = [];
  const nextSeq = () => ++state.seq;
  const emit = (eventType, data) => {
    data.sequence_number = nextSeq();
    events.push({ event: eventType, data });
  };

  for (const i in state.msgItemAdded) closeMessage(state, emit, i);
  closeReasoning(state, emit);
  for (const i in state.toolCallStates) closeToolCall(state, emit, i);
  sendCompleted(state, emit);

  return events;
}

// currentToolCallId is intentionally sticky for the current turn so flush/completion
  // can still finalize as tool_calls even if the tool call was emitted before stream end.
function computeFinishReason(state) {
   return state.toolCallIndex > 0 || state.currentToolCallId
    ? OPENAI_FINISH.TOOL_CALLS
    : OPENAI_FINISH.STOP;
}

/**
 * Translate OpenAI Responses API chunk to OpenAI Chat Completions format
 * This is for when Codex returns data and we need to send it to an OpenAI-compatible client
 */
export function openaiResponsesToOpenAIResponse(chunk, state) {
  if (!chunk) {
    // Flush: send final chunk with finish_reason
    if (state.finishReasonSent || !state.started) return null;

    const finishReason = computeFinishReason(state);

    state.finishReasonSent = true;
    state.finishReason = finishReason;

    const finalChunk = buildChunk(
      { id: state.chatId || `chatcmpl-${Date.now()}`, created: state.created || Math.floor(Date.now() / 1000), model: state.model || MODEL_FALLBACK },
      {},
      finishReason
    );

    if (state.usage && typeof state.usage === "object") {
      finalChunk.usage = state.usage;
    }

    return finalChunk;
  }

  // Handle different event types from Responses API
  const eventType = chunk.type || chunk.event;
  const data = chunk.data || chunk;

  // Initialize state
  if (!state.started) {
    state.started = true;
    state.chatId = `chatcmpl-${Date.now()}`;
    state.created = Math.floor(Date.now() / 1000);
    state.toolCallIndex = 0;
    state.currentToolCallId = null;
  }

  // Text content delta
  if (eventType === "response.output_text.delta") {
    const delta = data.delta || "";
    if (!delta) return null;

    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      { content: delta }
    );
  }

  // Text content done (ignore, we handle via delta)
  if (eventType === "response.output_text.done") {
    return null;
  }

  // Function call started (standard function_call or custom_tool_call)
  if (eventType === "response.output_item.added" && (data.item?.type === RESPONSES_ITEM.FUNCTION_CALL || data.item?.type === "custom_tool_call")) {
    const item = data.item;
    state.currentToolCallId = item.call_id || fallbackToolCallId();

    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      {
        tool_calls: [{
          index: state.toolCallIndex,
          id: state.currentToolCallId,
          type: OPENAI_BLOCK.FUNCTION,
          function: { name: item.name || "", arguments: "" }
        }]
      }
    );
  }

  // Function call arguments delta (standard or custom_tool_call variant)
  if (eventType === "response.function_call_arguments.delta" || eventType === "response.custom_tool_call_input.delta") {
    const argsDelta = data.delta || "";
    if (!argsDelta) return null;

    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      { tool_calls: [{ index: state.toolCallIndex, function: { arguments: argsDelta } }] }
    );
  }

  // Function call done (standard or custom_tool_call variant)
  if (eventType === "response.output_item.done" && (data.item?.type === RESPONSES_ITEM.FUNCTION_CALL || data.item?.type === "custom_tool_call")) {
    state.toolCallIndex++;
    return null;
  }

  // Response completed
  if (eventType === "response.completed" || eventType === "response.done") {
    // Extract usage from response.completed event
    const responseUsage = data.response?.usage;
    if (responseUsage && typeof responseUsage === "object") {
      const inputTokens = responseUsage.input_tokens || responseUsage.prompt_tokens || 0;
      const outputTokens = responseUsage.output_tokens || responseUsage.completion_tokens || 0;
      // OpenAI Responses API: input_tokens already includes cached_tokens
      // Cache info is in input_tokens_details.cached_tokens
      const cacheReadTokens = responseUsage.input_tokens_details?.cached_tokens || responseUsage.cache_read_input_tokens || 0;

      state.usage = buildUsage({ promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens, cachedTokens: cacheReadTokens });
    }

    if (!state.finishReasonSent) {
      const finishReason = computeFinishReason(state);

      state.finishReasonSent = true;
      state.finishReason = finishReason; // Mark for usage injection in stream.js

      const finalChunk = buildChunk(
        { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
        {},
        finishReason
      );

      // Include usage in final chunk if available
      if (state.usage && typeof state.usage === "object") {
        finalChunk.usage = state.usage;
      }

      return finalChunk;
    }
    return null;
  }

  // Error events from Responses API (e.g. model_not_found)
  if (eventType === "error" || eventType === "response.failed") {
    // Avoid emitting duplicate errors (error + response.failed arrive back-to-back)
    if (state.finishReasonSent) return null;

    const error = data.error || data.response?.error;
    if (error) {
      state.error = error;
      state.finishReasonSent = true;

      // Surface the error as an OpenAI-compatible error chunk
      return buildChunk(
        { id: state.chatId || `chatcmpl-${Date.now()}`, created: state.created || Math.floor(Date.now() / 1000), model: state.model || MODEL_FALLBACK },
        { content: `[Error] ${error.message || JSON.stringify(error)}` },
        OPENAI_FINISH.STOP
      );
    }
    return null;
  }

  // Reasoning summary delta → emit as reasoning_content for client thinking display
  if (eventType === "response.reasoning_summary_text.delta") {
    const delta = data.delta || "";
    if (!delta) return null;
    return buildChunk(
      { id: state.chatId, created: state.created, model: state.model || MODEL_FALLBACK },
      reasoningDelta(delta)
    );
  }

  // Ignore other events
  return null;
}

// Register both directions
register(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, null, openaiToOpenAIResponsesResponse);
register(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, null, openaiResponsesToOpenAIResponse);

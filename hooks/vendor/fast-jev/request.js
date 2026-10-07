const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
function buildJevRequest(params, state, questions) {
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: "POST",
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      state,
      questions
    })
  };
}
function parseJevResponse(status, ok, text) {
  if (!ok) {
    throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Jev returned malformed JSON");
  }
  if (parsed === null || typeof parsed !== "object" || !("answers" in parsed) || parsed.answers === null || typeof parsed.answers !== "object") {
    throw new Error("Jev response is missing answers");
  }
  return parsed;
}
function noulAnswer(answers, name) {
  const answer = answers[name];
  if (!answer || !("noul" in answer) || typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}
export {
  DEFAULT_MODEL,
  SYSTEM_ONE_URL,
  buildJevRequest,
  noulAnswer,
  parseJevResponse
};

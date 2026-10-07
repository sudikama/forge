// Scripted Jev for the large E2E (FORGE_JEV_LANES=mock,zen). Only routing and the hybrid
// finding decision are scripted; every other purpose passes through to the next lane.
export default (state, questions, purpose) => {
  if (purpose === 'route-lane') {
    // Small slices (W2 money(), W3 toUSD()) are mechanical: Jev is confident they are fast.
    if ((state.items || []).every((i) => i.size === 'S')) return { tier: { choice: 'fast', confidence: 0.92 }, effort: { choice: 'low', confidence: 0.9 } }
    return { tier: { choice: 'balanced', confidence: 0.8 }, effort: { choice: 'medium', confidence: 0.8 } }
  }
  if (purpose === 'route-orchestrator') return { tier: { choice: 'fast', confidence: 1 }, effort: { choice: 'low', confidence: 1 } }
  if (purpose === 'finding-decide') {
    const t = String(state.finding?.title || '')
    if (/report output/.test(t)) return { which: { choice: 'x0', confidence: 0.9 } } // Non-goals: report.mjs output
    return { which: { choice: 'none', confidence: 1 } }
  }
  return null
}

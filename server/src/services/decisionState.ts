export type DecisionConclusion = "success" | "failure" | "action_required";

/**
 * Only what decides the gate. Deliberately structural rather than the stored
 * record, so the repository can compute the desired conclusion when it marks a
 * review for synchronization without depending on the GitHub client.
 */
export interface DecisionSubject {
  decision: "pending" | "approved" | "rejected";
  decisionNote: string | null;
  blockingFindings: number;
}

export interface DecisionCheckState {
  conclusion: DecisionConclusion;
  title: string;
  summary: string;
}

/**
 * How a stored decision reads as a merge gate.
 *
 * A change with nothing blocking needs no reviewer, so it must not sit waiting
 * for one. A blocking finding that nobody has ruled on is `action_required`
 * rather than a plain failure, because the resolution is a person opening the
 * review, not a code change.
 */
export function decisionCheckState(subject: DecisionSubject): DecisionCheckState {
  const blocking = subject.blockingFindings;
  if (subject.decision === "approved") {
    return {
      conclusion: "success",
      title: blocking > 0 ? "Accepted with a justified exception" : "Approved",
      summary: blocking > 0
        ? `A reviewer accepted this architecture change with ${blocking} blocking finding(s) outstanding.`
        : "A reviewer approved this architecture change.",
    };
  }
  if (subject.decision === "rejected") {
    return {
      conclusion: "failure",
      title: "Rejected",
      summary: subject.decisionNote
        ? `A reviewer rejected this architecture change: ${subject.decisionNote}`
        : "A reviewer rejected this architecture change.",
    };
  }
  if (blocking === 0) {
    return {
      conclusion: "success",
      title: "No decision required",
      summary: "This change introduces no blocking architecture findings.",
    };
  }
  return {
    conclusion: "action_required",
    title: `${blocking} blocking change awaiting a decision`,
    summary:
      "Open the architecture review to resolve the finding, accept a justified exception, or reject the change.",
  };
}

/** Adapts a stored review to the subset the gate depends on. */
export function reviewDecisionSubject(review: {
  decision: "pending" | "approved" | "rejected";
  decisionNote: string | null;
  report: { blockingFindings: unknown[] };
}): DecisionSubject {
  return {
    decision: review.decision,
    decisionNote: review.decisionNote,
    blockingFindings: review.report.blockingFindings.length,
  };
}

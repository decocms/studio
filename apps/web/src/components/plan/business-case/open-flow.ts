/** Where the person is in the flow. The tab keeps it, so leaving for the
 *  canvas and coming back does not lose an answer. */
export interface OpenFlowProgress {
  /** Taken when the flow opened, so a case write meanwhile does not move
   *  the questions under the person. */
  questions: string[];
  /** By question; past `step` when the person went back. */
  answers: string[];
  step: number;
}

export function startOpenFlow(
  questions: string[],
  saved: OpenFlowProgress | null,
): OpenFlowProgress {
  const same =
    saved?.questions.length === questions.length &&
    saved.questions.every((question, i) => question === questions[i]);
  return same ? saved : { questions, answers: [], step: 0 };
}

#!/usr/bin/env python3
"""Search for better guidance wording for FRIDAY with DSPy's GEPA optimizer.

  tune.py <input.json>   ->  prints JSON {"instruction", "baseline", "best"}

input.json: {"soul", "tasks": [{"input", "rubric", "category"}], "model", "grader", "api_base",
             "max_metric_calls"}. The result is only a candidate: FRIDAY's own 30-task benchmark
gate and Sir's approval decide whether it is ever used.
"""

import json
import re
import sys

import dspy

START = "Reply to Sir as FRIDAY, following everything in the soul."


def lm(model: str, api_base: str) -> dspy.LM:
    # Through FRIDAY's local proxy; a thinking budget keeps its Gemini models from stalling.
    return dspy.LM(
        f"anthropic/{model}",
        api_base=api_base,
        api_key="local-proxy",
        max_tokens=3000,
        temperature=1.0,
        thinking={"type": "enabled", "budget_tokens": 1024},
        cache=False,
    )


class Reply(dspy.Signature):
    """Reply to Sir as FRIDAY, following everything in the soul."""

    soul: str = dspy.InputField(desc="FRIDAY's personality and rules")
    message: str = dspy.InputField(desc="What Sir just said")
    reply: str = dspy.OutputField(desc="FRIDAY's reply, as she would say it")


def main() -> None:
    cfg = json.load(open(sys.argv[1]))
    student, judge = lm(cfg["model"], cfg["api_base"]), lm(cfg["grader"], cfg["api_base"])
    dspy.configure(lm=student)

    def grade(example, pred, trace=None, pred_name=None, pred_trace=None):
        prompt = (
            f"Message: {example.message}\nRubric: {example.rubric}\n\nReply:\n{pred.reply}\n\n"
            'Grade the reply against the rubric. Answer ONLY with JSON: {"score": 0-10, "why": "<one sentence>"}'
        )
        raw = judge(prompt)[0]
        m = re.search(r"\{[^{}]*\}", raw if isinstance(raw, str) else str(raw))
        data = json.loads(m.group(0)) if m else {}
        score = max(0.0, min(10.0, float(data.get("score", 0)))) / 10
        return dspy.Prediction(score=score, feedback=str(data.get("why", "")))

    examples = [
        dspy.Example(soul=cfg["soul"], message=t["input"], rubric=t["rubric"]).with_inputs("soul", "message")
        for t in cfg["tasks"]
    ]
    program = dspy.Predict(Reply)
    evaluate = dspy.Evaluate(devset=examples, metric=lambda e, p, t=None: grade(e, p).score, num_threads=4)
    baseline = float(evaluate(program).score)

    optimizer = dspy.GEPA(
        metric=grade,
        reflection_lm=judge,
        max_metric_calls=int(cfg.get("max_metric_calls", 120)),
        num_threads=4,
        track_stats=False,
    )
    tuned = optimizer.compile(program, trainset=examples, valset=examples)
    best = float(evaluate(tuned).score)
    instruction = tuned.signature.instructions.strip()
    json.dump(
        {"instruction": instruction if instruction != START else "", "baseline": baseline, "best": best},
        sys.stdout,
    )


if __name__ == "__main__":
    main()

# Inference-agent prompts of the paper (Appendix E.1)

Taken verbatim from the `lstlisting` blocks of Appendix E.1 in the LaTeX source of arXiv:2608.27454 (CC BY 4.0),
extracted and compared character by character (only a final newline is added). The paper's wording, punctuation and
line breaks are preserved.
`{skill_section}` is where the evolved skills go. The paper does not show how that section is rendered; this tool
fills it with an "## Available Skills" block.

Use with `--agent-prompt benchmarks/prompts/<name>.txt`.

| File | Benchmark | Notes |
|---|---|---|
| `livemath.txt` | LiveMathematicianBench | single-step, no tools |
| `sealqa.txt` | SealQA | needs `web_search` and `read_file` tools |
| `spreadsheetbench.txt` | SpreadsheetBench | needs per-task files and a bash tool; the instruction fields are filled by the task input |
| `officeqa.txt` | OfficeQA | needs local text files and glob/grep/read tools |
| `alfworld.txt` | ALFWorld | a **per-step** template filled by an environment loop (placeholders other than `{skill_section}` are not supported by this tool); needs an environment adapter, see docs/REPRODUCTION.md |

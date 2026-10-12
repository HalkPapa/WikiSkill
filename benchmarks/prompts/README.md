# Inference-agent prompts of the paper (Appendix E.1)

Transcribed from the HTML version of arXiv:2608.27454 (CC BY 4.0), where punctuation was spaced out by the page
renderer; line breaks and punctuation here are reconstructed. **Check them against the PDF before reporting numbers.**
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

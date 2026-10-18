# Knowledge Summary · Document Agent

A local Windows app that turns uploaded PPTX, PDF, DOCX, Markdown, and text documents into chapter-organized Chinese knowledge summaries with content-based file names.

The pipeline extracts text with source locations, asks Codex to plan chapters, uses DeepSeek to identify knowledge points in chunks, and asks Codex to edit the final Markdown, merging duplicates while preserving source references. Completed runs can be reformatted using cached DeepSeek extractions.

The project-local [document-knowledge skill](skills/document-knowledge/SKILL.md) supplies concise rules to the planner, extractor, and final editor. Restart the server after editing it.

Requires Windows 10/11, Node.js 24+, a logged-in [Codex CLI](https://github.com/openai/codex), and a [DeepSeek API key](https://api-docs.deepseek.com/). Run pnpm install (or npm install), then node src/server.mjs.

Open http://127.0.0.1:4173, configure the API key, choose an output directory, and upload 1–10 files (up to 25 MB each). The output name uses the extracted topic, with a number appended for repeated names. Existing files are never overwritten. The result is linked in the task response.

PDFs need a selectable text layer; scanned PDFs require OCR first. Embedded images and complex charts are not recognized. Legacy .ppt and .doc files should be converted to .pptx and .docx. Run tests with node --test.

The local server has no login authentication. Use it only on your own computer; do not expose it through port forwarding or a reverse proxy. It checks the local Host and cross-origin write requests, and limits expanded Office XML size.

The idea was inspired by [Fei2411/DeepSeek-Bot](https://github.com/Fei2411/DeepSeek-Bot); no source code was copied. [MIT License](LICENSE).

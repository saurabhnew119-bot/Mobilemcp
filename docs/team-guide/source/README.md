# Rebuilding the team guide

1. `powershell -File draw-flowcharts.ps1` renders the two flowchart PNGs next to this file.
2. `npm install docx@9.5.1` in this folder (one time), then
   `set REPO_URL=https://github.com/<org>/mobile-mcp.git && node build-doc.js ..\Mobilemcp-Team-Guide.docx`
   writes the Word file with the real clone URL.
3. `python -I check-doc.py ..\Mobilemcp-Team-Guide.docx` runs the brand structure checks.

`build-doc.js` expects the Monocept brand assets (logo SVG and watermark PNG) at the
path in its `BRAND` constant; adjust it for your machine.

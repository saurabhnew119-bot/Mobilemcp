"""Structural brand checks on a .docx (no external deps)."""
import re
import sys
import zipfile

path = sys.argv[1]
z = zipfile.ZipFile(path)
names = z.namelist()
problems = []

def part(n):
    return z.read(n).decode("utf8") if n in names else ""

text_parts = [n for n in names if re.match(r"word/(document|header\d*|footer\d*|footnotes|endnotes|styles)\.xml$", n)]
for n in text_parts:
    x = part(n)
    for bad in ("Times New Roman", "Calibri", "Arial", "Cambria", "Segoe UI", "Consolas"):
        if bad in x:
            problems.append(f"{n}: off-brand font {bad}")
    for m in re.finditer(r"<w:rFonts[^>]*>", x):
        tag = m.group(0)
        if ("Theme=" in tag) and ("w:ascii=" in tag):
            problems.append(f"{n}: rFonts mixes theme + explicit font: {tag[:120]}")

styles = part("word/styles.xml")
ids = re.findall(r'w:styleId="([^"]+)"', styles)
dups = {i for i in ids if ids.count(i) > 1}
if dups:
    problems.append(f"styles.xml duplicate styleIds: {sorted(dups)}")
for sid, font, color, sz in [("Heading1", "Harabara Mais", "FF601F", "40"), ("Heading2", "Harabara Mais", "FF601F", "32"),
                             ("Heading3", "Palatino Linotype", "333333", "26"), ("Heading4", "Palatino Linotype", "333333", "22"),
                             ("Title", "Harabara Mais", "FF601F", "72")]:
    m = re.search(r'<w:style[^>]*w:styleId="%s".*?</w:style>' % sid, styles, re.S)
    if not m:
        problems.append(f"styles.xml: style {sid} missing")
        continue
    blk = m.group(0)
    for needle, label in ((font, "font"), (color, "color"), (f'w:val="{sz}"', "size")):
        if needle not in blk:
            problems.append(f"styles.xml: {sid} lacks {label} {needle}")
dd = re.search(r"<w:docDefaults>.*?</w:docDefaults>", styles, re.S)
if not dd or "Palatino Linotype" not in dd.group(0):
    problems.append("styles.xml docDefaults not Palatino Linotype")

doc = part("word/document.xml")
orphans = 0
for m in re.finditer(r"<w:r>(.*?)</w:r>", doc, re.S):
    body = m.group(1)
    if "<w:t" in body and ("<w:rPr>" not in body or "w:rFonts" not in body or "w:sz " not in body and "w:sz/" not in body and "<w:sz " not in body):
        orphans += 1
if orphans:
    problems.append(f"document.xml: {orphans} text runs without explicit rFonts/sz")

custom = part("docProps/custom.xml")
for prop in ("MonoceptBrandSkillVersion", "MonoceptBrandSkillDate"):
    if prop not in custom:
        problems.append(f"custom.xml missing {prop}")

media = [n for n in names if n.startswith("word/media/")]
for n in media:
    if n.endswith(".undefined"):
        problems.append(f"media with .undefined extension: {n}")

footer = "".join(part(n) for n in names if re.match(r"word/footer\d*\.xml", n))
for needle in ("Monocept® Confidential", "https://www.monocept.com", "NUMPAGES", "Formatted with Monocept Brand Skill v2.3"):
    if needle not in footer:
        problems.append(f"footer missing: {needle}")
sect = re.search(r"<w:sectPr.*?</w:sectPr>", doc, re.S)
if not sect or "w:pgBorders" not in sect.group(0):
    problems.append("no page border in sectPr")
settings = part("word/settings.xml")
if "<w:updateFields" in settings:
    problems.append("settings.xml has updateFields (triggers Word prompt)")

print("media:", media)
print("header parts:", [n for n in names if "header" in n])
if problems:
    print("PROBLEMS:")
    for p in problems:
        print(" -", p)
    sys.exit(1)
print("ALL CHECKS PASSED")

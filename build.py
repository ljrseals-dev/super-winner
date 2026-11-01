import re, pathlib
r = pathlib.Path(__file__).parent
t = (r / "demo/template.html").read_text()
rd = lambda p: p.read_text()
full = (t.replace("/*WK_DRIFT*/", rd(r / "vendor/analog-drift.worklet.js")).replace("/*WK_PLATE*/", rd(r / "vendor/worklets.js"))
         .replace("/*CORE*/", rd(r / "src/core.js")).replace("/*ENGINE*/", rd(r / "src/engine.js")).replace("/*CHOIR*/", rd(r / "src/choir.js")))
(r / "index.html").write_text(full)
a = re.sub(r"<!--DL-->.*?<!--/DL-->", "", full, flags=re.S)
a = re.sub(r"/\*DL\*/.*?/\*/DL\*/", "", a, flags=re.S)
(r / "artifact.html").write_text(a)
print(len(full), len(a), "a.download" in a)

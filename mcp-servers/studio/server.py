#!/usr/bin/env python3
"""FRIDAY studio MCP server: engineering, CAD, circuits, video, graphics and defensive security.

Runs over stdio (started by FRIDAY's gateway). Built only on well-known open source:
the official `mcp` SDK, CadQuery (CAD), SymPy/NumPy/SciPy/Pint (engineering math), Pillow and
CairoSVG (graphics), FFmpeg (video), Semgrep (code scanning) and Nmap (own network only).

Every output file goes to ~/friday/generated/studio so the HUD can show images and Sir can find
them. Input files must live under Sir's home folder and never under credential folders.
"""

from __future__ import annotations

import ipaddress
import json
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
from pathlib import Path

from mcp.server.fastmcp import FastMCP

HOME = Path.home().resolve()
OUT = HOME / "friday" / "generated" / "studio"
BLOCKED = [HOME / ".friday" / "credentials", HOME / ".ssh", HOME / ".gnupg", HOME / ".aws"]
PY = sys.executable

mcp = FastMCP("studio")


# ---------- helpers ----------


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "item"


def _out(name: str, ext: str) -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    return OUT / f"{time.strftime('%Y%m%d-%H%M%S')}-{_slug(name)}.{ext.lstrip('.')}"


def _inp(path: str) -> Path:
    p = Path(path).expanduser().resolve()
    if HOME not in p.parents and p != HOME:
        raise ValueError("Only files inside Sir's home folder are allowed.")
    if any(b == p or b in p.parents for b in BLOCKED):
        raise ValueError("That folder holds credentials; I will not open it.")
    if not p.exists():
        raise ValueError(f"File not found: {p}")
    return p


def _run(cmd: list[str], timeout: int = 300, cwd: str | None = None) -> str:
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)
    tail = (r.stderr or "")[-1500:] if r.returncode else ""
    if r.returncode:
        raise RuntimeError(f"{cmd[0]} failed ({r.returncode}): {tail}")
    return r.stdout


def _ffmpeg(args: list[str], out: Path, timeout: int = 900) -> str:
    _run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args, str(out)], timeout=timeout)
    return f"Saved {out} ({out.stat().st_size // 1024} KB)"


def _media_line(path: Path) -> str:
    return f"MEDIA:{path}"


# ---------- CAD & engineering ----------


@mcp.tool()
def cad_build(code: str, name: str = "part") -> str:
    """Build a 3D part with CadQuery. `code` is Python that imports cadquery as cq and assigns
    the finished solid or workplane to a variable named `result`. Exports STEP and STL, and
    returns volume, bounding box and file paths. Example:
    result = cq.Workplane("XY").box(40, 20, 10).faces(">Z").hole(6)"""
    OUT.mkdir(parents=True, exist_ok=True)
    step, stl = _out(name, "step"), _out(name, "stl")
    runner = textwrap.dedent(
        f"""
        import cadquery as cq, json
        ns = {{"cq": cq}}
        exec(compile({code!r}, "cad_build", "exec"), ns)
        r = ns.get("result")
        if r is None:
            raise SystemExit("Set a variable named result.")
        cq.exporters.export(r, {str(step)!r})
        cq.exporters.export(r, {str(stl)!r})
        s = r.val() if hasattr(r, "val") else r
        bb = s.BoundingBox()
        print(json.dumps({{"volume_mm3": round(s.Volume(), 3), "bbox_mm": [round(bb.xlen, 3), round(bb.ylen, 3), round(bb.zlen, 3)],
                           "valid": bool(s.isValid())}}))
        """
    )
    with tempfile.TemporaryDirectory() as d:
        out = _run([PY, "-c", runner], timeout=180, cwd=d)
    return f"{out.strip()}\nSTEP: {step}\nSTL: {stl}"


@mcp.tool()
def engineering_calc(code: str) -> str:
    """Run an engineering calculation in Python. numpy as np, scipy, sympy as sp, pint's
    unit registry `ureg`, python-control as ct (transfer functions, Bode, step, PID, stability),
    scikit-fem as skfem (finite elements: stress, heat, deflection) and networkx as nx are preloaded.
    Print the answers. Use for statics, beams, FEA, thermal, fluids, control and units-safe maths."""
    pre = (
        "import matplotlib; matplotlib.use('Agg')\n"
        "import numpy as np, scipy, sympy as sp, math\nimport pint, control as ct, networkx as nx, skfem\n"
        "ureg = pint.UnitRegistry()\nQ = ureg.Quantity\n"
    )
    with tempfile.TemporaryDirectory() as d:
        return _run([PY, "-c", pre + code], timeout=120, cwd=d).strip() or "(no output; print your result)"


@mcp.tool()
def circuit_solve(netlist: str, frequency_hz: float = 0.0) -> str:
    """Solve a linear circuit by nodal analysis (DC when frequency_hz is 0, else AC steady state).
    One element per line: `R1 n1 n2 1k`, `C1 n1 n2 100n`, `L1 n1 n2 10m`, `V1 n1 n2 5` (n1 is +),
    `I1 n1 n2 1m` (current flows n1 to n2 through the source). Ground node is `0`.
    Values take SI suffixes (p n u m k M G). Returns node voltages and source currents."""
    import numpy as np

    mult = {"p": 1e-12, "n": 1e-9, "u": 1e-6, "m": 1e-3, "k": 1e3, "M": 1e6, "G": 1e9, "meg": 1e6}

    def val(s: str) -> float:
        m = re.fullmatch(r"([-+0-9.eE]+)(meg|[pnumkMG])?", s)
        if not m:
            raise ValueError(f"Bad value: {s}")
        return float(m.group(1)) * mult.get(m.group(2) or "", 1.0)

    els = []
    for raw in netlist.strip().splitlines():
        t = raw.split("#")[0].split()
        if not t:
            continue
        if len(t) != 4:
            raise ValueError(f"Need 'name n1 n2 value': {raw}")
        els.append((t[0], t[1], t[2], val(t[3])))
    nodes = sorted({n for _, a, b, _ in els for n in (a, b) if n != "0"})
    idx = {n: i for i, n in enumerate(nodes)}
    vs = [e for e in els if e[0][0].upper() == "V"]
    n, m = len(nodes), len(vs)
    w = 2 * np.pi * frequency_hz
    A = np.zeros((n + m, n + m), dtype=complex)
    z = np.zeros(n + m, dtype=complex)

    def stamp(a: str, b: str, y: complex) -> None:
        for p, q, s in ((a, a, 1), (b, b, 1), (a, b, -1), (b, a, -1)):
            if p != "0" and q != "0":
                A[idx[p], idx[q]] += s * y

    for name, a, b, v in els:
        k = name[0].upper()
        if k == "R":
            stamp(a, b, 1 / v)
        elif k == "C":
            stamp(a, b, 1j * w * v)
        elif k == "L":
            stamp(a, b, 1 / (1j * w * v) if w else 1e9)
        elif k == "I":
            if a != "0":
                z[idx[a]] -= v
            if b != "0":
                z[idx[b]] += v
        elif k != "V":
            raise ValueError(f"Unknown element {name}")
    for j, (name, a, b, v) in enumerate(vs):
        r = n + j
        if a != "0":
            A[idx[a], r] += 1
            A[r, idx[a]] += 1
        if b != "0":
            A[idx[b], r] -= 1
            A[r, idx[b]] -= 1
        z[r] = v
    x = np.linalg.solve(A, z)

    def fmt(c: complex) -> str:
        return f"{c.real:.6g}" if abs(c.imag) < 1e-12 * max(1, abs(c.real)) else f"{abs(c):.6g} ∠ {np.degrees(np.angle(c)):.2f}°"

    lines = [f"{'AC at %g Hz' % frequency_hz if w else 'DC'} solution:"]
    lines += [f"V({nm}) = {fmt(x[idx[nm]])} V" for nm in nodes]
    lines += [f"I({vs[j][0]}) = {fmt(x[n + j])} A" for j in range(m)]
    return "\n".join(lines)


def _need(binary: str, apt: str) -> str:
    path = shutil.which(binary)
    if not path:
        raise RuntimeError(f"{binary} is not installed. Sir can run: sudo apt install -y {apt}")
    return path


@mcp.tool()
def openscad_build(code: str, name: str = "scad") -> str:
    """Build a 3D part from OpenSCAD source. Saves STL and a PNG preview (MEDIA line)."""
    exe = _need("openscad", "openscad")
    src, stl, png = _out(name, "scad"), _out(name, "stl"), _out(name, "png")
    src.write_text(code, encoding="utf-8")
    _run([exe, "-o", str(stl), str(src)], timeout=300)
    try:
        _run(["xvfb-run", "-a", exe, "-o", str(png), "--imgsize=1000,800", "--autocenter", "--viewall", str(src)], timeout=120) if shutil.which("xvfb-run") else _run([exe, "-o", str(png), "--imgsize=1000,800", "--autocenter", "--viewall", str(src)], timeout=120)
        prev = f"\n{_media_line(png)}"
    except Exception:
        prev = "\n(no preview: needs a display)"
    return f"SCAD: {src}\nSTL: {stl}{prev}"


@mcp.tool()
def spice_run(netlist: str, name: str = "sim") -> str:
    """Run a real SPICE simulation with ngspice in batch mode. `netlist` is a normal SPICE deck
    including analysis (.op, .tran, .ac, .dc) and `.print` lines. Returns the printed results."""
    exe = _need("ngspice", "ngspice")
    deck = _out(name, "cir")
    deck.write_text(netlist if netlist.lower().rstrip().endswith(".end") else netlist + "\n.end\n", encoding="utf-8")
    return _run([exe, "-b", str(deck)], timeout=180)[-8000:]


@mcp.tool()
def kicad_check(path: str, action: str = "erc") -> str:
    """Check or export a KiCad project file with kicad-cli. path: .kicad_sch or .kicad_pcb.
    action: erc (schematic rules), drc (board rules), pdf (export schematic/board to PDF)."""
    exe = _need("kicad-cli", "kicad")
    p = _inp(path)
    if action == "erc":
        out = _out("erc", "txt")
        _run([exe, "sch", "erc", "--output", str(out), "--severity-all", str(p)], timeout=300)
        return out.read_text()[-6000:]
    if action == "drc":
        out = _out("drc", "txt")
        _run([exe, "pcb", "drc", "--output", str(out), "--severity-all", str(p)], timeout=300)
        return out.read_text()[-6000:]
    if action == "pdf":
        out = _out(p.stem, "pdf")
        sub = ["sch", "export", "pdf"] if p.suffix == ".kicad_sch" else ["pcb", "export", "pdf", "--layers", "F.Cu,B.Cu,F.SilkS,Edge.Cuts"]
        _run([exe, *sub, "--output", str(out), str(p)], timeout=300)
        return f"Saved {out}"
    raise ValueError("action must be erc, drc or pdf")


@mcp.tool()
def svg_export(path: str, format: str = "pdf", name: str = "export") -> str:
    """Export an SVG with Inkscape to pdf, png, eps or plain svg (text converted to paths for print)."""
    exe = _need("inkscape", "inkscape")
    out = _out(name, format)
    _run([exe, str(_inp(path)), "--export-type=" + format, "--export-filename=" + str(out), "--export-text-to-path"], timeout=180)
    return f"Saved {out}" + (f"\n{_media_line(out)}" if format == "png" else "")


@mcp.tool()
def drawing_dxf(entities: str, name: str = "drawing") -> str:
    """Make a 2D engineering drawing as DXF (opens in any CAD) plus a PNG preview. `entities` is a
    JSON list: {"t":"line","a":[x,y],"b":[x,y]}, {"t":"circle","c":[x,y],"r":5},
    {"t":"arc","c":[x,y],"r":5,"start":0,"end":90}, {"t":"rect","a":[x,y],"b":[x,y]},
    {"t":"text","at":[x,y],"text":"M6","h":3}, {"t":"dim","a":[x,y],"b":[x,y],"offset":6}. Units are mm."""
    import ezdxf
    from ezdxf.addons.drawing import Frontend, RenderContext, matplotlib as dxf_plt

    doc = ezdxf.new("R2018", setup=True)
    doc.units = ezdxf.units.MM
    msp = doc.modelspace()
    for e in json.loads(entities):
        t = e["t"]
        if t == "line":
            msp.add_line(e["a"], e["b"])
        elif t == "circle":
            msp.add_circle(e["c"], e["r"])
        elif t == "arc":
            msp.add_arc(e["c"], e["r"], e["start"], e["end"])
        elif t == "rect":
            (x1, y1), (x2, y2) = e["a"], e["b"]
            msp.add_lwpolyline([(x1, y1), (x2, y1), (x2, y2), (x1, y2)], close=True)
        elif t == "text":
            msp.add_text(e["text"], height=e.get("h", 3)).set_placement(e["at"])
        elif t == "dim":
            a, b = e["a"], e["b"]
            msp.add_linear_dim(base=(a[0], a[1] + e.get("offset", 6)), p1=a, p2=b).render()
        else:
            raise ValueError(f"Unknown entity {t}")
    dxf, png = _out(name, "dxf"), _out(name, "png")
    doc.saveas(dxf)
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig = plt.figure(figsize=(9, 7))
    ax = fig.add_axes([0, 0, 1, 1])
    Frontend(RenderContext(doc), dxf_plt.MatplotlibBackend(ax)).draw_layout(msp)
    fig.savefig(png, dpi=140)
    return f"DXF: {dxf}\nPNG: {png}\n{_media_line(png)}"


# ---------- graphics ----------


@mcp.tool()
def image_edit(path: str, operations: str, name: str = "edit") -> str:
    """Edit an image with Pillow. `operations` is a JSON list applied in order, each like
    {"op":"resize","width":800}, {"op":"crop","box":[l,t,r,b]}, {"op":"rotate","degrees":90},
    {"op":"grayscale"}, {"op":"blur","radius":2}, {"op":"sharpen"}, {"op":"contrast","factor":1.3},
    {"op":"brightness","factor":1.1}, {"op":"text","text":"Hi","xy":[20,20],"size":48,"color":"#ffffff"},
    {"op":"convert","format":"png|jpg|webp"}. Returns a MEDIA line the HUD can show."""
    from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

    img = Image.open(_inp(path)).convert("RGBA")
    fmt = "png"
    for op in json.loads(operations):
        k = op["op"]
        if k == "resize":
            w, h = op.get("width"), op.get("height")
            w = w or round(img.width * h / img.height)
            h = h or round(img.height * w / img.width)
            img = img.resize((int(w), int(h)), Image.LANCZOS)
        elif k == "crop":
            img = img.crop(tuple(op["box"]))
        elif k == "rotate":
            img = img.rotate(-float(op["degrees"]), expand=True)
        elif k == "grayscale":
            img = img.convert("L").convert("RGBA")
        elif k == "blur":
            img = img.filter(ImageFilter.GaussianBlur(float(op.get("radius", 2))))
        elif k == "sharpen":
            img = img.filter(ImageFilter.SHARPEN)
        elif k == "contrast":
            img = ImageEnhance.Contrast(img).enhance(float(op["factor"]))
        elif k == "brightness":
            img = ImageEnhance.Brightness(img).enhance(float(op["factor"]))
        elif k == "text":
            try:
                font = ImageFont.truetype("DejaVuSans-Bold.ttf", int(op.get("size", 40)))
            except OSError:
                font = ImageFont.load_default()
            ImageDraw.Draw(img).text(tuple(op.get("xy", [10, 10])), op["text"], fill=op.get("color", "#ffffff"), font=font)
        elif k == "convert":
            fmt = op["format"].lower().replace("jpeg", "jpg")
        else:
            raise ValueError(f"Unknown op {k}")
    out = _out(name, fmt)
    img.convert("RGB").save(out) if fmt in ("jpg", "jpeg") else img.save(out)
    return f"Saved {out}\n{_media_line(out)}"


@mcp.tool()
def svg_render(svg: str, name: str = "graphic", width: int = 1200) -> str:
    """Draw vector graphics: pass SVG markup (logos, icons, diagrams, posters). Saves the .svg and a
    PNG render. Returns a MEDIA line the HUD can show."""
    import cairosvg

    svg_path, png_path = _out(name, "svg"), _out(name, "png")
    svg_path.write_text(svg, encoding="utf-8")
    cairosvg.svg2png(bytestring=svg.encode("utf-8"), write_to=str(png_path), output_width=int(width))
    return f"SVG: {svg_path}\nPNG: {png_path}\n{_media_line(png_path)}"


@mcp.tool()
def plot_chart(code: str, name: str = "chart") -> str:
    """Make a chart with matplotlib. `code` uses plt (matplotlib.pyplot) and np; do not call show().
    The figure is saved as PNG. Returns a MEDIA line the HUD can show."""
    out = _out(name, "png")
    runner = (
        "import matplotlib; matplotlib.use('Agg')\nimport matplotlib.pyplot as plt, numpy as np\n"
        + code
        + f"\nplt.tight_layout(); plt.savefig({str(out)!r}, dpi=160)\n"
    )
    with tempfile.TemporaryDirectory() as d:
        _run([PY, "-c", runner], timeout=120, cwd=d)
    return f"Saved {out}\n{_media_line(out)}"


# ---------- video & audio ----------


@mcp.tool()
def media_probe(path: str) -> str:
    """Show duration, streams, codecs, resolution and frame rate of a video or audio file."""
    return _run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(_inp(path))], timeout=60)[:6000]


@mcp.tool()
def video_trim(path: str, start: str, end: str = "", name: str = "trim") -> str:
    """Cut a clip. start/end are seconds or HH:MM:SS. Leave end empty to go to the end."""
    out = _out(name, "mp4")
    args = ["-ss", start, "-i", str(_inp(path))] + (["-to", end] if end else []) + ["-c:v", "libx264", "-c:a", "aac"]
    return _ffmpeg(args, out)


@mcp.tool()
def video_concat(paths: list[str], name: str = "joined") -> str:
    """Join several clips in order (they are re-encoded to match)."""
    ins: list[str] = []
    for p in paths:
        ins += ["-i", str(_inp(p))]
    n = len(paths)
    filt = "".join(f"[{i}:v:0][{i}:a:0]" for i in range(n)) + f"concat=n={n}:v=1:a=1[v][a]"
    return _ffmpeg([*ins, "-filter_complex", filt, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-c:a", "aac"], _out(name, "mp4"))


@mcp.tool()
def video_convert(path: str, width: int = 0, fps: int = 0, format: str = "mp4", speed: float = 1.0, name: str = "converted") -> str:
    """Convert or resize a video; optionally change fps and speed (2.0 = twice as fast). format: mp4, webm, gif, mp3."""
    vf = []
    if speed != 1.0:
        vf.append(f"setpts=PTS/{speed}")
    if width:
        vf.append(f"scale={int(width)}:-2")
    if fps:
        vf.append(f"fps={int(fps)}")
    args = ["-i", str(_inp(path))]
    if format == "mp3":
        args += ["-vn", "-q:a", "2"]
    else:
        if vf:
            args += ["-vf", ",".join(vf)]
        if speed != 1.0 and format != "gif":
            args += ["-af", f"atempo={speed}"]
    return _ffmpeg(args, _out(name, format))


@mcp.tool()
def video_overlay_text(path: str, text: str, size: int = 48, position: str = "bottom", name: str = "titled") -> str:
    """Burn a caption or title onto a video. position: top, center or bottom."""
    y = {"top": "h*0.08", "center": "(h-text_h)/2", "bottom": "h*0.85"}.get(position, "h*0.85")
    safe = text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "’")
    vf = f"drawtext=text='{safe}':fontcolor=white:fontsize={int(size)}:box=1:boxcolor=black@0.5:boxborderw=12:x=(w-text_w)/2:y={y}"
    return _ffmpeg(["-i", str(_inp(path)), "-vf", vf, "-c:a", "copy"], _out(name, "mp4"))


@mcp.tool()
def video_frame(path: str, at: str = "00:00:01", name: str = "frame") -> str:
    """Grab one still frame as PNG so it can be looked at. Returns a MEDIA line."""
    out = _out(name, "png")
    _ffmpeg(["-ss", at, "-i", str(_inp(path)), "-frames:v", "1"], out)
    return f"Saved {out}\n{_media_line(out)}"


# ---------- computer science ----------

LANGS = {
    "python": ("main.py", None, [PY, "main.py"]),
    "node": ("main.js", None, ["node", "main.js"]),
    "bash": ("main.sh", None, ["bash", "main.sh"]),
    "c": ("main.c", ["gcc", "-O2", "-o", "prog", "main.c", "-lm"], ["./prog"]),
    "cpp": ("main.cpp", ["g++", "-O2", "-std=c++20", "-o", "prog", "main.cpp"], ["./prog"]),
    "java": ("Main.java", ["javac", "-J-Xmx256m", "Main.java"], ["java", "-Xmx512m", "-XX:+UseSerialGC", "Main"]),
    "go": ("main.go", None, ["/snap/go/current/bin/go", "run", "main.go"]),
}


@mcp.tool()
def run_code(language: str, code: str, stdin: str = "", timeout_s: int = 20) -> str:
    """Compile and run a snippet in a locked-down sandbox: temp folder, no network, 1 GB memory,
    limited CPU time and processes. language: python, node, bash, c, cpp, java, go. Use it to
    test algorithms, reproduce bugs and check answers before telling Sir they work."""
    if language not in LANGS:
        raise ValueError(f"language must be one of {', '.join(LANGS)}")
    fname, build, run = LANGS[language]
    # Java and Go reserve huge virtual ranges, so they get no address-space cap (CPU, processes and
    # file size stay limited, the network is off, and java is held to a 512 MB heap).
    mem = [] if language in ("java", "go") else ["--as=1073741824"]
    jail = ["unshare", "-rn", "prlimit", *mem, f"--cpu={int(timeout_s) + 5}", "--nproc=1024", "--fsize=50000000"]
    with tempfile.TemporaryDirectory() as d:
        (Path(d) / fname).write_text(code, encoding="utf-8")
        env_note = ""
        if build:
            b = subprocess.run([*jail, *build], capture_output=True, text=True, cwd=d, timeout=120)
            if b.returncode:
                return f"COMPILE ERROR:\n{(b.stderr or b.stdout)[-3000:]}"
        t0 = time.time()
        try:
            r = subprocess.run([*jail, *run], input=stdin, capture_output=True, text=True, cwd=d, timeout=int(timeout_s), env={"PATH": "/usr/local/bin:/usr/bin:/bin:/snap/bin", "HOME": d, "GOCACHE": d + "/.gocache", "GOFLAGS": "-mod=mod", "GOMEMLIMIT": "700MiB", "GOMAXPROCS": "2", "GOROOT": "/snap/go/current"})
        except subprocess.TimeoutExpired:
            return f"TIMEOUT after {timeout_s}s (possible infinite loop or too slow)."
        return f"exit {r.returncode} in {time.time() - t0:.2f}s{env_note}\n--- stdout ---\n{r.stdout[-6000:]}\n--- stderr ---\n{r.stderr[-2500:]}"


@mcp.tool()
def data_query(sql: str, files: list[str]) -> str:
    """Analyse data with SQL (DuckDB). `files` are CSV, JSON, Parquet or Excel-free tabular files under
    Sir's home; each becomes a table named after the file (data.csv -> data). Example:
    SELECT city, avg(price) FROM sales GROUP BY city ORDER BY 2 DESC. Returns up to 200 rows."""
    import duckdb
    import pandas as pd

    con = duckdb.connect()
    for f in files:
        p = _inp(f)
        df = {".csv": pd.read_csv, ".json": pd.read_json, ".parquet": pd.read_parquet, ".tsv": lambda x: pd.read_csv(x, sep="\t")}.get(p.suffix.lower())
        if df is None:
            raise ValueError(f"Unsupported file type: {p.suffix}")
        con.register(re.sub(r"\W+", "_", p.stem), df(p))
    con.execute("SET enable_external_access=false")
    out = con.execute(sql).fetchdf()
    return f"{len(out)} row(s)\n" + out.head(200).to_string(index=False)


@mcp.tool()
def data_science_run(code: str) -> str:
    """Run Python for data science and machine learning: pandas as pd, numpy as np, sklearn, duckdb and
    matplotlib (plt) are ready. Print results. Save charts with plt.savefig('/tmp/x.png') only if
    you then pass them to image tools; prefer plot_chart for pictures. Always hold out test data."""
    pre = "import matplotlib; matplotlib.use('Agg')\nimport pandas as pd, numpy as np, sklearn, duckdb\nimport matplotlib.pyplot as plt\n"
    with tempfile.TemporaryDirectory() as d:
        return _run([PY, "-c", pre + code], timeout=300, cwd=d).strip() or "(no output; print your result)"


@mcp.tool()
def lint_project(path: str) -> str:
    """Quality check of a Python project or file: Ruff lint findings plus Radon cyclomatic complexity
    (functions rated C or worse) and maintainability index. Report the worst offenders with fixes."""
    p = _inp(path)
    bin_dir = Path(PY).parent
    ruff = subprocess.run([str(bin_dir / "ruff"), "check", "--output-format=concise", "--no-cache", str(p)], capture_output=True, text=True, timeout=300)
    cc = subprocess.run([str(bin_dir / "radon"), "cc", "-n", "C", "-s", str(p)], capture_output=True, text=True, timeout=300)
    mi = subprocess.run([str(bin_dir / "radon"), "mi", "-n", "B", "-s", str(p)], capture_output=True, text=True, timeout=300)
    return f"RUFF:\n{ruff.stdout[-3500:] or 'clean'}\nCOMPLEXITY (C or worse):\n{cc.stdout[-2000:] or 'none'}\nMAINTAINABILITY (B or worse):\n{mi.stdout[-1500:] or 'none'}"


@mcp.tool()
def bench_command(command: list[str], runs: int = 10, cwd: str = "") -> str:
    """Time a command several times (no shell; pass argv like ["python","x.py"]). Returns min, mean,
    median and spread in seconds, so performance claims come with numbers."""
    import statistics

    runs = max(2, min(int(runs), 50))
    wd = str(_inp(cwd)) if cwd else None
    times = []
    for _ in range(runs):
        t = time.perf_counter()
        r = subprocess.run(command, capture_output=True, cwd=wd, timeout=300)
        times.append(time.perf_counter() - t)
        if r.returncode:
            raise RuntimeError(f"command failed ({r.returncode}): {r.stderr[-500:].decode(errors='ignore')}")
    return f"{runs} runs: min {min(times):.4f}s  mean {statistics.mean(times):.4f}s  median {statistics.median(times):.4f}s  stdev {statistics.pstdev(times):.4f}s"


# ---------- defensive security ----------

SECRET_PATTERNS = {
    "private key": r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "AWS access key": r"AKIA[0-9A-Z]{16}",
    "Google API key": r"AIza[0-9A-Za-z_\-]{35}",
    "GitHub token": r"gh[pousr]_[A-Za-z0-9]{36,}",
    "Slack token": r"xox[baprs]-[A-Za-z0-9-]{10,}",
    "generic secret": r"(?i)(api[_-]?key|secret|passwd|password|token)\s*[:=]\s*['\"][^'\"\s]{12,}['\"]",
}
SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "dist", "__pycache__", ".next"}


@mcp.tool()
def secrets_scan(path: str) -> str:
    """Look for leaked secrets (keys, tokens, private keys) in a folder or file. Values are never
    printed, only file, line and kind, so the report is safe to share."""
    root = _inp(path)
    files = [root] if root.is_file() else [f for f in root.rglob("*") if f.is_file() and not (SKIP_DIRS & set(f.parts))]
    hits = []
    for f in files[:20000]:
        try:
            if f.stat().st_size > 1_000_000:
                continue
            text = f.read_text(errors="ignore")
        except OSError:
            continue
        for kind, pat in SECRET_PATTERNS.items():
            for m in re.finditer(pat, text):
                hits.append(f"{f}:{text.count(chr(10), 0, m.start()) + 1}  {kind}")
    return "No secrets found." if not hits else f"{len(hits)} possible secret(s):\n" + "\n".join(hits[:200])


@mcp.tool()
def code_scan(path: str, ruleset: str = "p/default") -> str:
    """Static analysis of source code with Semgrep for security bugs. ruleset examples: p/default,
    p/owasp-top-ten, p/python, p/javascript, p/typescript, p/secrets."""
    semgrep = Path(PY).parent / "semgrep"
    out = _run([str(semgrep), "scan", "--config", ruleset, "--json", "--quiet", "--metrics=off", str(_inp(path))], timeout=900)
    res = json.loads(out).get("results", [])
    if not res:
        return "Semgrep found no issues."
    rows = [f"{r['path']}:{r['start']['line']}  [{r['extra'].get('severity')}] {r['check_id'].split('.')[-1]}: {r['extra'].get('message', '')[:160]}" for r in res[:60]]
    return f"{len(res)} finding(s):\n" + "\n".join(rows)


@mcp.tool()
def network_scan(target: str, ports: str = "1-1024") -> str:
    """Scan Sir's OWN machine or private network for open ports with Nmap. Only loopback and private
    addresses (10.x, 172.16-31.x, 192.168.x) are allowed; public targets are refused."""
    if not shutil.which("nmap"):
        raise RuntimeError("nmap is not installed.")
    if not re.fullmatch(r"[0-9.:/a-fA-F]+|localhost", target):
        raise ValueError("Give an IP address, CIDR range or localhost.")
    net = ipaddress.ip_network("127.0.0.1" if target == "localhost" else target, strict=False)
    if not (net.is_private or net.is_loopback) or net.num_addresses > 256:
        raise ValueError("Refused: only loopback or private ranges up to 256 addresses are scanned. Public hosts need Sir's own written permission.")
    if not re.fullmatch(r"[0-9,\-]+", ports):
        raise ValueError("ports must look like 22,80 or 1-1024")
    return _run(["nmap", "-sT", "-sV", "-T3", "--open", "-p", ports, str(net) if target != "localhost" else "127.0.0.1"], timeout=600)[-6000:]


if __name__ == "__main__":
    mcp.run()

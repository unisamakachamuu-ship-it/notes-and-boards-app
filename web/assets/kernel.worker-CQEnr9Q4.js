(function(){let e=String.raw`
import sys, os, io, ast, json, time, types, base64, inspect, builtins, linecache, traceback, reprlib, pprint, re, shlex, importlib, keyword
from js import nbkEmit, nbkRequestInput
import pyodide_js

os.environ.setdefault("MPLBACKEND", "Agg")
import warnings
warnings.filterwarnings("ignore", message=".*non-interactive, and thus cannot be shown")

ns = {"__name__": "__main__", "__builtins__": builtins, "__doc__": None}
counter = 0
_HIDE = {"In", "Out", "exit", "quit", "get_ipython"}

def _emit(kind, payload):
    nbkEmit(kind, json.dumps(payload, default=str))

# ---------------------------------------------------------------- streams
class _Stream(io.TextIOBase):
    encoding = "utf-8"
    def __init__(self, name):
        self._name = name
    @property
    def name(self):
        return "<" + self._name + ">"
    def writable(self):
        return True
    def isatty(self):
        return False
    def write(self, s):
        if not isinstance(s, str):
            s = str(s)
        if s:
            _emit("stream", {"name": self._name, "text": s})
        return len(s)
    def flush(self):
        pass

sys.stdout = _Stream("stdout")
sys.stderr = _Stream("stderr")

# ---------------------------------------------------------------- rich display
_MIMES = (
    ("_repr_html_", "text/html"),
    ("_repr_svg_", "image/svg+xml"),
    ("_repr_png_", "image/png"),
    ("_repr_jpeg_", "image/jpeg"),
    ("_repr_latex_", "text/latex"),
    ("_repr_markdown_", "text/markdown"),
    ("_repr_json_", "application/json"),
)

def _pretty(obj):
    if isinstance(obj, (dict, list, tuple, set, frozenset)):
        s = pprint.pformat(obj, width=100, compact=True, sort_dicts=False)
    else:
        s = repr(obj)
    if len(s) > 20000:
        s = s[:20000] + "\n… (output truncated)"
    return s

def _fig_png(fig):
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=110, bbox_inches="tight")
    return base64.b64encode(buf.getvalue()).decode()

def _bundle(obj):
    data = {}
    figmod = sys.modules.get("matplotlib.figure")
    if figmod is not None and isinstance(obj, figmod.Figure):
        return {"image/png": _fig_png(obj), "text/plain": "<Figure>"}
    if _is_plotly_fig(obj):
        return {"text/html": _plotly_html(obj), "text/plain": "<plotly Figure>"}
    if type(obj).__module__.startswith("bokeh.") and hasattr(obj, "document") and hasattr(obj, "select"):
        try:
            return {"text/html": _bokeh_html(obj), "text/plain": "<bokeh %s>" % type(obj).__name__}
        except Exception:
            pass
    if not isinstance(obj, type):
        mb = getattr(obj, "_repr_mimebundle_", None)
        if callable(mb):
            try:
                r = mb(include=None, exclude=None)
                if isinstance(r, tuple):
                    r = r[0]
                if isinstance(r, dict):
                    for k, v in r.items():
                        if isinstance(v, bytes):
                            v = base64.b64encode(v).decode()
                        elif not isinstance(v, str):
                            v = json.dumps(v, default=str)
                        data[k] = v
            except Exception:
                pass
        for meth, mime in _MIMES:
            if mime in data:
                continue
            f = getattr(obj, meth, None)
            if not callable(f):
                continue
            try:
                v = f()
            except Exception:
                continue
            if v is None:
                continue
            if isinstance(v, tuple):
                v = v[0]
            if isinstance(v, bytes):
                v = base64.b64encode(v).decode()
            elif mime == "application/json":
                v = json.dumps(v, default=str)
            data[mime] = str(v)
    if "text/plain" not in data:
        try:
            data["text/plain"] = _pretty(obj)
        except Exception as e:
            data["text/plain"] = "<repr failed: %s>" % e
    return data

def display(*objs, **kw):
    for o in objs:
        _emit("display", {"data": _bundle(o)})

def clear_output(wait=False):
    _emit("clear", {})

def _flush_figures():
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    if not getattr(plt, "_nbk_patched", False):
        plt.show = lambda *a, **k: _flush_figures()
        plt._nbk_patched = True
    for n in plt.get_fignums():
        fig = plt.figure(n)
        if fig.get_axes() or fig.texts or fig.images:
            display(fig)
    plt.close("all")

builtins.display = display

# minimal IPython.display shim so tutorials work unchanged
class _Raw:
    _mime = "text/plain"
    def __init__(self, data=None, url=None, filename=None, **kw):
        if filename:
            mode = "rb" if self._mime.startswith("image/") and self._mime != "image/svg+xml" else "r"
            with open(filename, mode) as f:
                data = f.read()
        self.data = data
        self.url = url
        self.kw = kw
    def __repr__(self):
        return "<%s object>" % type(self).__name__

class HTML(_Raw):
    def _repr_html_(self): return self.data
class Markdown(_Raw):
    def _repr_markdown_(self): return self.data
class Latex(_Raw):
    def _repr_latex_(self): return self.data
class Math(_Raw):
    def _repr_latex_(self): return "$$%s$$" % self.data
class SVG(_Raw):
    _mime = "image/svg+xml"
    def _repr_svg_(self): return self.data
class JSON(_Raw):
    def _repr_json_(self): return self.data
class Image(_Raw):
    _mime = "image/png"
    def __init__(self, data=None, url=None, filename=None, format=None, **kw):
        super().__init__(data, url, filename, **kw)
        self.format = (format or (filename or "png").rsplit(".", 1)[-1]).lower()
    def _repr_png_(self):
        if self.format == "png" and isinstance(self.data, bytes): return self.data
    def _repr_jpeg_(self):
        if self.format in ("jpg", "jpeg") and isinstance(self.data, bytes): return self.data
    def _repr_html_(self):
        if self.url and self.data is None: return '<img src="%s">' % self.url

_ipd = types.ModuleType("IPython.display")
for _n, _v in dict(display=display, clear_output=clear_output, HTML=HTML, Markdown=Markdown, Latex=Latex, Math=Math, SVG=SVG, JSON=JSON, Image=Image).items():
    setattr(_ipd, _n, _v)
_ip = types.ModuleType("IPython")
_ip.display = _ipd
_ip.get_ipython = lambda: None  # libraries (matplotlib, tqdm, plotly) probe for a running IPython
_ip.version_info = (8, 0, 0, "")
_ip.__version__ = "8.0.0"

class _IPythonShim:
    """Serves the shim only when code imports IPython and the real package isn't installed."""
    def find_spec(self, name, path=None, target=None):
        if name not in ("IPython", "IPython.display"):
            return None
        import importlib.machinery, importlib.util
        if importlib.machinery.PathFinder.find_spec("IPython") is not None:
            return None
        return importlib.util.spec_from_loader(name, self, is_package=(name == "IPython"))
    def create_module(self, spec):
        return _ip if spec.name == "IPython" else _ipd
    def exec_module(self, module):
        pass

sys.meta_path.append(_IPythonShim())

# ---------------------------------------------------------------- chart libraries
# Interactive charts render as HTML in the cell (their JS loads from the libraries' CDNs).
# show() would otherwise try to open a browser tab, so it's redirected to display().
def _is_plotly_fig(obj):
    return type(obj).__module__.startswith("plotly.") and hasattr(obj, "to_html") and hasattr(obj, "to_plotly_json")

def _plotly_html(fig):
    return fig.to_html(include_plotlyjs="cdn", full_html=False, default_height=460,
                       config={"responsive": True, "displaylogo": False})

def _bokeh_html(obj):
    from bokeh.embed import file_html
    from bokeh.resources import CDN
    return file_html(obj, CDN)

def _patch_plotly(mod):
    mod.BaseFigure.show = lambda self, *a, **k: display(self)

def _patch_plotly_io(mod):
    mod.show = lambda fig, *a, **k: display(fig)

def _bokeh_show(obj, *a, **k):
    display(HTML(_bokeh_html(obj)))

def _patch_bokeh(mod):
    mod.show = _bokeh_show

def _patch_altair(mod):
    try:
        mod.renderers.enable("html")
    except Exception:
        pass

_POST_IMPORT = {
    "plotly.basedatatypes": _patch_plotly,
    "plotly.io": _patch_plotly_io,
    "bokeh.io": _patch_bokeh,
    "bokeh.plotting": _patch_bokeh,
    "altair": _patch_altair,
}

class _PostImport:
    """Runs a patch right after certain modules finish importing."""
    def find_spec(self, name, path=None, target=None):
        hook = _POST_IMPORT.get(name)
        if hook is None:
            return None
        spec = None
        for f in sys.meta_path:
            if f is self or not hasattr(f, "find_spec"):
                continue
            spec = f.find_spec(name, path, target)
            if spec is not None:
                break
        if spec is None or spec.loader is None or not hasattr(spec.loader, "exec_module"):
            return spec
        orig = spec.loader.exec_module
        def exec_module(module):
            orig(module)
            try:
                hook(module)
            except Exception:
                pass
        spec.loader.exec_module = exec_module
        return spec

sys.meta_path.insert(0, _PostImport())

# ---------------------------------------------------------------- input()
def _input(prompt=""):
    try:
        from pyodide.ffi import run_sync
    except ImportError:
        run_sync = None
    if run_sync is None:
        raise RuntimeError("input() is not supported by this Python runtime. Assign the value in code instead.")
    sys.stdout.write(str(prompt))
    try:
        v = run_sync(nbkRequestInput(str(prompt)))
    except Exception as e:
        raise RuntimeError("input() needs a browser with JavaScript Promise Integration (Chrome or Edge 137+). Assign the value in code instead.") from None
    if v is None:
        raise KeyboardInterrupt()
    sys.stdout.write(str(v) + "\n")
    return str(v)

builtins.input = _input

# ---------------------------------------------------------------- magics
class _Timer:
    def __enter__(self):
        self.t = time.perf_counter()
    def __exit__(self, *a):
        dt = time.perf_counter() - self.t
        print("Wall time: %s" % _fmt_time(dt))

def _fmt_time(dt):
    if dt < 1e-6: return "%.0f ns" % (dt * 1e9)
    if dt < 1e-3: return "%.1f µs" % (dt * 1e6)
    if dt < 1: return "%.1f ms" % (dt * 1e3)
    return "%.2f s" % dt

def timer():
    return _Timer()

def timeit(stmt):
    import timeit as _ti
    t = _ti.Timer(stmt, globals=ns)
    n, total = t.autorange()
    runs = [total / n] + [x / n for x in t.repeat(repeat=4, number=n)]
    import statistics
    mean, sd = statistics.mean(runs), (statistics.stdev(runs) if len(runs) > 1 else 0)
    print("%s ± %s per loop (mean ± std. dev. of %d runs, %d loops each)" % (_fmt_time(mean), _fmt_time(sd), len(runs), n))

PIP_NAMES = {"sklearn": "scikit-learn", "cv2": "opencv-python", "PIL": "pillow", "bs4": "beautifulsoup4", "yaml": "pyyaml", "skimage": "scikit-image", "dateutil": "python-dateutil", "Bio": "biopython", "attr": "attrs", "google.protobuf": "protobuf"}

async def pip_install(args):
    await pyodide_js.loadPackage("micropip")
    import micropip
    pkgs = [a for a in shlex.split(args) if not a.startswith("-")]
    if not pkgs:
        print("Usage: %pip install <package> [<package> ...]")
        return
    for p in pkgs:
        print("Installing %s …" % p)
        await micropip.install(PIP_NAMES.get(p, p))
        print("✓ Installed %s" % p)

def who(long=False):
    rows = variables_list()
    if not rows:
        print("Interactive namespace is empty.")
        return
    if not long:
        print("   ".join(r["name"] for r in rows))
        return
    w = max(len(r["name"]) for r in rows)
    t = max(len(r["type"]) for r in rows)
    print("%s  %s  %s" % ("Variable".ljust(w), "Type".ljust(t), "Data/Info"))
    print("-" * (w + t + 30))
    for r in rows:
        print("%s  %s  %s" % (r["name"].ljust(w), r["type"].ljust(t), (r["shape"] + " " if r["shape"] else "") + r["repr"]))

def pinfo(expr, detail=False):
    try:
        obj = eval(expr, ns)
    except Exception as e:
        print("Object '%s' not found." % expr)
        return
    print("Type:      %s" % type(obj).__name__)
    try:
        print("Signature: %s%s" % (expr, inspect.signature(obj)))
    except Exception:
        pass
    if not callable(obj) or isinstance(obj, (int, float, str)):
        print("Value:     %s" % reprlib.repr(obj))
    doc = inspect.getdoc(obj)
    if doc:
        print("Docstring:\n" + doc)
    if detail:
        try:
            print("Source:\n" + inspect.getsource(obj))
        except Exception:
            pass

def shell(cmd):
    print("Shell commands are not available in the browser runtime (%s). Use %%pip install <pkg> to add packages." % cmd.strip(), file=sys.stderr)

def _magic_line(line):
    """Translate one IPython-style line into Python, or return None."""
    m = re.match(r"^(\s*)(.*)$", line)
    ind, body = m.group(1), m.group(2)
    if body.startswith("!"):
        cmd = body[1:].strip()
        if re.match(r"^pip3?\s+install\b", cmd):
            return ind + "await _nbk.pip_install(%r)" % re.sub(r"^pip3?\s+install\s*", "", cmd)
        return ind + "_nbk.shell(%r)" % cmd
    if body.startswith("%") and not body.startswith("%%"):
        name, _, rest = body[1:].partition(" ")
        rest = rest.strip()
        if name in ("pip", "pip3") and rest.startswith("install"):
            return ind + "await _nbk.pip_install(%r)" % rest[len("install"):].strip()
        if name == "time":
            return ind + "with _nbk.timer(): " + rest
        if name == "timeit":
            return ind + "_nbk.timeit(%r)" % rest
        if name in ("who", "whos"):
            return ind + "_nbk.who(%s)" % (name == "whos")
        if name == "reset":
            return ind + "_nbk.reset()"
        if name in ("matplotlib", "load_ext", "config", "autoreload", "reload_ext"):
            return ind + "pass"
        if name == "lsmagic":
            return ind + "print('Line magics: %pip install, %time, %timeit, %who, %whos, %reset, %matplotlib (no-op)\\nCell magics: %%time, %%timeit\\nHelp: obj? and obj??')"
        return ind + "print(%r, file=__import__('sys').stderr)" % ("UsageError: Line magic function '%%%s' not found." % name)
    q = re.match(r"^([A-Za-z_][\w.]*)(\?\??)$", body.strip())
    if q:
        return ind + "_nbk.pinfo(%r, %s)" % (q.group(1), len(q.group(2)) == 2)
    q = re.match(r"^(\?\??)([A-Za-z_][\w.]*)$", body.strip())
    if q:
        return ind + "_nbk.pinfo(%r, %s)" % (q.group(2), len(q.group(1)) == 2)
    return None

def transform(code):
    lines = code.split("\n")
    out = []
    for line in lines:
        t = _magic_line(line)
        out.append(line if t is None else t)
    return "\n".join(out)

def reset():
    keep = {"__name__", "__builtins__", "__doc__"}
    for k in list(ns):
        if k not in keep:
            del ns[k]
    print("Namespace cleared.")

# ---------------------------------------------------------------- execution
def _emit_error(etype, value, tb, fname=None):
    # drop frames that belong to the kernel itself
    while tb is not None and tb.tb_frame.f_code.co_filename == "<nbk>":
        tb = tb.tb_next
    if isinstance(value, SyntaxError) and tb is None:
        lines = traceback.format_exception_only(etype, value)
    else:
        lines = traceback.format_exception(etype, value, tb)
    payload = {"ename": etype.__name__, "evalue": str(value), "traceback": [l.rstrip("\n") for l in lines]}
    if isinstance(value, ModuleNotFoundError) and value.name:
        top = value.name.split(".")[0]
        payload["missing"] = PIP_NAMES.get(top, top)
    _emit("error", payload)

async def run_cell(code):
    global counter
    counter += 1
    n = counter
    cell_time = None
    stripped = code.lstrip()
    if stripped.startswith("%%time"):
        first, _, code = stripped.partition("\n")
        if first.startswith("%%timeit"):
            timeit(code)
            return {"count": n, "ok": True}
        cell_time = time.perf_counter()
    src = transform(code)
    fname = "<cell [%d]>" % n
    linecache.cache[fname] = (len(src), None, src.splitlines(True), fname)
    ok = True
    try:
        tree = compile(src, fname, "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT | ast.PyCF_ONLY_AST)
    except SyntaxError:
        _emit_error(*sys.exc_info())
        return {"count": n, "ok": False}
    last = None
    if tree.body and isinstance(tree.body[-1], ast.Expr) and not src.rstrip().endswith(";"):
        last = ast.Expression(tree.body.pop().value)
    flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
    try:
        if tree.body:
            co = compile(tree, fname, "exec", flags=flags)
            r = eval(co, ns)
            if co.co_flags & inspect.CO_COROUTINE:
                await r
        if last is not None:
            co = compile(last, fname, "eval", flags=flags)
            v = eval(co, ns)
            if co.co_flags & inspect.CO_COROUTINE:
                v = await v
            if v is not None:
                ns["_"] = v
                ns["_%d" % n] = v
                figmod = sys.modules.get("matplotlib.figure")
                is_artist = type(v).__module__.startswith("matplotlib.") and not (figmod and isinstance(v, figmod.Figure))
                if not is_artist and not (isinstance(v, list) and v and type(v[0]).__module__.startswith("matplotlib.")):
                    _emit("result", {"data": _bundle(v), "count": n})
    except BaseException:
        ok = False
        _flush_figures()
        _emit_error(*sys.exc_info())
    else:
        _flush_figures()
    if cell_time is not None:
        print("Wall time: %s" % _fmt_time(time.perf_counter() - cell_time))
    return {"count": n, "ok": ok}

# ---------------------------------------------------------------- introspection
_jedi = None
def _script(code):
    global _jedi
    if _jedi is None:
        import jedi
        jedi.settings.case_insensitive_completion = True
        jedi.settings.add_bracket_after_function = False
        _jedi = jedi
    return _jedi.Interpreter(code, [ns])

def complete(code, line, col):
    out = []
    try:
        comps = _script(code).complete(line, col)
    except Exception:
        return "[]"
    for i, c in enumerate(comps[:200]):
        item = {"label": c.name, "type": c.type, "complete": c.complete}
        if i < 14 and not c.name.startswith("_"):
            try:
                sigs = c.get_signatures()
                if sigs:
                    item["detail"] = sigs[0].to_string()
            except Exception:
                pass
            try:
                d = c.docstring(raw=True, fast=True)
                if d:
                    item["doc"] = d[:700]
            except Exception:
                pass
        out.append(item)
    return json.dumps(out)

def signatures(code, line, col):
    try:
        sigs = _script(code).get_signatures(line, col)
    except Exception:
        return "[]"
    out = []
    for s in sigs[:3]:
        try:
            doc = s.docstring(raw=True)
        except Exception:
            doc = ""
        out.append({"label": s.to_string(), "name": s.name, "params": [p.to_string() for p in s.params], "index": s.index, "doc": (doc or "")[:900]})
    return json.dumps(out)

def hover(code, line, col):
    try:
        s = _script(code)
        names = s.help(line, col) or s.infer(line, col)
    except Exception:
        return "null"
    for nm in names[:1]:
        try:
            sigs = nm.get_signatures()
        except Exception:
            sigs = []
        try:
            doc = nm.docstring(raw=True)
        except Exception:
            doc = ""
        return json.dumps({"name": nm.full_name or nm.name, "type": nm.type, "sig": sigs[0].to_string() if sigs else "", "doc": (doc or "")[:2500]})
    return "null"

def lint(code):
    src = transform(code)
    try:
        compile(src, "<cell>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT | ast.PyCF_ONLY_AST)
    except SyntaxError as e:
        return json.dumps([{"line": e.lineno or 1, "col": max((e.offset or 1) - 1, 0), "endLine": getattr(e, "end_lineno", None), "endCol": (getattr(e, "end_offset", None) or 0) - 1, "msg": "%s: %s" % (type(e).__name__, e.msg)}])
    except Exception:
        pass
    return "[]"

def _shape(v):
    sh = getattr(v, "shape", None)
    if isinstance(sh, tuple):
        return " × ".join(str(x) for x in sh) if sh else "scalar"
    if isinstance(v, (str, bytes, list, tuple, dict, set, frozenset)):
        return "len %d" % len(v)
    return ""

_r = reprlib.Repr()
_r.maxstring = 120
_r.maxother = 120
_r.maxlist = 8

def variables_list():
    rows = []
    for k, v in list(ns.items()):
        if k.startswith("_") or k in _HIDE or isinstance(v, types.ModuleType):
            continue
        if inspect.isfunction(v) or inspect.isclass(v) or inspect.isbuiltin(v):
            kind = "function" if not inspect.isclass(v) else "class"
            rows.append({"name": k, "type": kind, "shape": "", "repr": (k + str(inspect.signature(v))) if kind == "function" and _safe_sig(v) else type(v).__name__ if kind == "function" else v.__qualname__})
            continue
        try:
            rep = _r.repr(v)
        except Exception:
            rep = "<unrepresentable>"
        rows.append({"name": k, "type": type(v).__name__, "shape": _shape(v), "repr": rep})
    return rows

def _safe_sig(v):
    try:
        inspect.signature(v)
        return True
    except Exception:
        return False

def variables():
    return json.dumps(variables_list())

def modules():
    std = sorted(n for n in sys.stdlib_module_names if not n.startswith("_") and n not in ("antigravity", "this"))
    installed = {}
    try:
        import importlib.metadata as md
        for d in md.distributions():
            try:
                installed[d.metadata["Name"].lower()] = d.version
            except Exception:
                pass
    except Exception:
        pass
    loaded = sorted(n for n in sys.modules if "." not in n and not n.startswith("_"))
    return json.dumps({"stdlib": std, "installed": installed, "loaded": loaded})

def module_info(name):
    mod = importlib.import_module(name)
    names = getattr(mod, "__all__", None)
    if not isinstance(names, (list, tuple)):
        names = [n for n in dir(mod) if not n.startswith("_")]
    members = []
    for n in list(names)[:500]:
        try:
            obj = getattr(mod, n)
        except Exception:
            continue
        if inspect.ismodule(obj):
            kind = "module"
        elif inspect.isclass(obj):
            kind = "exception" if issubclass(obj, BaseException) else "class"
        elif callable(obj):
            kind = "function"
        else:
            kind = "constant"
        sig = ""
        if kind in ("function", "class"):
            try:
                sig = str(inspect.signature(obj))
            except Exception:
                sig = "(…)" if kind == "function" else ""
        if kind == "constant":
            try:
                doc = _r.repr(obj)
            except Exception:
                doc = ""
        else:
            doc = (inspect.getdoc(obj) or "").strip().split("\n\n")[0].replace("\n", " ")[:260]
        members.append({"name": n, "kind": kind, "sig": sig, "doc": doc})
    subs = []
    if hasattr(mod, "__path__"):
        try:
            import pkgutil
            subs = sorted(m.name for m in pkgutil.iter_modules(mod.__path__) if not m.name.startswith("_"))[:200]
        except Exception:
            pass
    return json.dumps({
        "name": name,
        "version": str(getattr(mod, "__version__", "") or ""),
        "file": str(getattr(mod, "__file__", "") or "built-in"),
        "doc": (inspect.getdoc(mod) or "")[:5000],
        "members": members,
        "submodules": subs,
    })

def member_doc(path):
    obj = None
    parts = path.split(".")
    for i in range(len(parts), 0, -1):
        try:
            obj = importlib.import_module(".".join(parts[:i]))
            for p in parts[i:]:
                obj = getattr(obj, p)
            break
        except Exception:
            obj = None
    if obj is None:
        return "null"
    try:
        sig = str(inspect.signature(obj))
    except Exception:
        sig = ""
    return json.dumps({"name": path, "sig": sig, "doc": (inspect.getdoc(obj) or "")[:6000]})
`,t=`https://cdn.jsdelivr.net/pyodide/v314.0.7/full/`,n=null,r=null,i=0,a=null,o=typeof WebAssembly.Suspending==`function`,s=/* @__PURE__ */ new Map,c=e=>self.postMessage(e),l=(e,t=``)=>c({type:`status`,state:e,message:t});self.nbkEmit=(e,t)=>c({type:`event`,id:i,kind:e,data:JSON.parse(t)}),self.nbkRequestInput=e=>new Promise(t=>{s.set(i,t),c({type:`input`,id:i,prompt:e})});async function u(i){l(`starting`,`Loading Python runtime…`);let{loadPyodide:a}=await import(
/* @vite-ignore */
t+`pyodide.mjs`);n=await a({indexURL:t}),i&&n.setInterruptBuffer(new Uint8Array(i)),n.globals.set(`__nbk_src`,e),n.runPython(`import sys, types
_m = types.ModuleType('_nbk')
sys.modules['_nbk'] = _m
exec(compile(__nbk_src, '<nbk>', 'exec'), _m.__dict__)
del _m`),r=n.pyimport(`_nbk`),r.ns.set(`_nbk`,r),l(`idle`,`Python `+n.runPython(`import sys; sys.version.split()[0]`)),n.loadPackage(`jedi`,{messageCallback:()=>{},errorCallback:()=>{}}).then(()=>setTimeout(()=>r.complete(`import os
os.pa`,2,5),0)).catch(()=>{})}async function d(){if(a)return a;try{let e=await(await fetch(t+`pyodide-lock.json`)).json();a=Object.values(e.packages).filter(e=>e.package_type!==`shared_library`&&e.package_type!==`cpython_module`).map(e=>({name:e.name,version:e.version,imports:e.imports??[],depends:e.depends??[]}))}catch{a=[]}return a}async function f(e,t){let r=e.split(`
`).map(e=>/^\s*[%!?]/.test(e)||/\?\s*$/.test(e)||/\bIPython\b/.test(e)?``:e).join(`
`);try{await n.loadPackagesFromImports(r,{messageCallback:e=>{/^Loading |^Loaded /.test(e)&&c({type:`event`,id:t,kind:`status`,data:{text:e}})},errorCallback:e=>!/\b(jedi|parso)\b/.test(e)&&c({type:`event`,id:t,kind:`stream`,data:{name:`stderr`,text:e+`
`}})})}catch{}try{let e=n.pyodide_py.code.find_imports(r).toJs();e.includes(`plotly`)&&/plotly\.express/.test(r)&&await n.loadPackage(`pandas`,{messageCallback:()=>{}});let i=e.filter(e=>p[e]&&!n.runPython(`import importlib.util as u; u.find_spec(${JSON.stringify(e)}) is not None`));if(!i.length)return;await n.loadPackage(`micropip`,{messageCallback:()=>{}});let a=n.pyimport(`micropip`);for(let e of i){c({type:`event`,id:t,kind:`status`,data:{text:`Installing ${p[e]} from PyPI…`}});try{await a.install(p[e])}catch(n){c({type:`event`,id:t,kind:`stream`,data:{name:`stderr`,text:`Couldn't install ${p[e]}: ${String(n?.message??n).split(`
`).slice(-2).join(` `)}\n`}})}}}catch{}}let p={plotly:`plotly`,seaborn:`seaborn`,mplfinance:`mplfinance`,squarify:`squarify`},m=Promise.resolve();async function h(e){let{id:t,type:a}=e;if(a===`init`)return u(e.interrupt);if(!n)throw Error(`Kernel is not running`);switch(a){case`run`:{let n=m.then(async()=>{c({type:`event`,id:t,kind:`start`,data:{}}),i=t,l(`busy`);try{await f(e.code,t);let n=r.run_cell,i=await(o&&n.callPromising?n.callPromising(e.code):n(e.code)),a=i?.toJs?i.toJs({dict_converter:Object.fromEntries}):i;return i?.destroy?.(),a}finally{l(`idle`)}});return m=n.catch(()=>{}),n}case`complete`:return JSON.parse(r.complete(e.code,e.line,e.col));case`signatures`:return JSON.parse(r.signatures(e.code,e.line,e.col));case`hover`:return JSON.parse(r.hover(e.code,e.line,e.col));case`lint`:return JSON.parse(r.lint(e.code));case`variables`:return JSON.parse(r.variables());case`modules`:return{...JSON.parse(r.modules()),packages:await d()};case`moduleInfo`:{let t=e.name.split(`.`)[0],i=(await d()).find(e=>e.imports.includes(t)||e.name===t);return i&&await n.loadPackage(i.name,{messageCallback:()=>{}}),JSON.parse(r.module_info(e.name))}case`memberDoc`:return JSON.parse(r.member_doc(e.path));case`install`:{i=t;let r=(await d()).find(t=>t.name.toLowerCase()===e.name.toLowerCase()||t.imports.includes(e.name));return r?(await n.loadPackage(r.name,{messageCallback:()=>{}}),{ok:!0,source:`pyodide`,version:r.version}):(await n.loadPackage(`micropip`,{messageCallback:()=>{}}),await n.pyimport(`micropip`).install(e.name),{ok:!0,source:`pypi`})}default:throw Error(`Unknown request `+a)}}self.onmessage=async e=>{let t=e.data;if(t.type===`inputReply`)s.get(t.id)?.(t.value),s.delete(t.id);else try{let e=await h(t);c({type:`reply`,id:t.id,value:e})}catch(e){t.type===`init`&&l(`dead`,String(e?.message??e)),c({type:`reply`,id:t.id,error:String(e?.message??e)})}}})();
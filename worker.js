// worker.js — roda o Pyodide dentro de um Web Worker de verdade.
//
// Por que um Worker (e não a thread principal)? Porque só um Worker pode
// chamar Atomics.wait() e bloquear de verdade — o que permite implementar
// input() como um campo de texto inline no terminal (sem window.prompt(),
// sem popup, sem botão de confirmar/cancelar), igual ao terminal do VSCode.
//
// Isso exige que a página esteja "cross-origin isolated" (COOP/COEP), pra
// que o navegador libere o uso de SharedArrayBuffer. Quem cuida disso é o
// sw.js (injeta os cabeçalhos na navegação, já que hospedagens estáticas
// como GitHub Pages não deixam configurar cabeçalhos HTTP de verdade).
//
// Canal de input: um SharedArrayBuffer de controle (2 int32: status e
// tamanho da resposta) + um SharedArrayBuffer de texto (Uint16, um code
// unit UTF-16 por posição — o mesmo formato interno das strings JS).
// Fluxo: builtins.input() -> js.requestInputSync(prompt) -> posta
// "input-request" pro thread principal -> Atomics.wait() bloqueia o worker
// -> thread principal escreve a resposta no buffer e chama Atomics.notify()
// -> o worker acorda, lê a string e devolve pro Python.

const PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js";

const PACKAGE_MAP = {
  numpy: "numpy",
  pandas: "pandas",
  matplotlib: "matplotlib",
  scipy: "scipy",
  sklearn: "scikit-learn",
  PIL: "Pillow",
  requests: "requests",
  regex: "regex",
  pytz: "pytz",
  dateutil: "python-dateutil",
  sympy: "sympy",
  networkx: "networkx",
  bs4: "beautifulsoup4",
  yaml: "pyyaml",
};

function detectPackages(code) {
  const found = new Set();
  const re = /^\s*(?:from|import)\s+([a-zA-Z_][\w]*)/gm;
  let m;
  while ((m = re.exec(code))) {
    const name = PACKAGE_MAP[m[1]];
    if (name) found.add(name);
  }
  return [...found];
}

function post(obj) {
  self.postMessage(JSON.stringify(obj));
}

// Eventos que o runtime Python emite (stdout, stderr, widgets de GUI etc.)
// chegam aqui e viram postMessage de string JSON — o formato que
// index.html já sabe interpretar via handleWorkerMessage.
self.dispatchPyEvent = function (jsonStr) {
  self.postMessage(jsonStr);
};

// ---------- Canal de input() bloqueante via SharedArrayBuffer ----------
const MAX_INPUT_CHARS = 4096;
const STATUS_IDLE = 0;
const STATUS_PENDING = 1;
const STATUS_READY = 2;

let sharedControl = null; // Int32Array: [0]=status, [1]=tamanho da resposta
let sharedText = null;    // Uint16Array: code units UTF-16 da resposta
let inputChannelAvailable = false;

// ---------- Diagnóstico: reporta o estado real de isolamento do worker ----------
// Isso roda sempre, independente de dar certo ou não, pra dar pra ver na tela
// do app (sem precisar de Mac/Web Inspector) o que exatamente está falhando.
self.postMessage({
  type: "coi-diag",
  workerCrossOriginIsolated: self.crossOriginIsolated,
  sharedArrayBufferDefined: typeof SharedArrayBuffer !== "undefined",
});

(function setupInputChannel() {
  try {
    if (typeof SharedArrayBuffer === "undefined" || !self.crossOriginIsolated) {
      inputChannelAvailable = false;
      return;
    }
    const controlBuf = new SharedArrayBuffer(8); // 2 x int32
    const textBuf = new SharedArrayBuffer(MAX_INPUT_CHARS * 2); // 2 bytes por code unit
    sharedControl = new Int32Array(controlBuf);
    sharedText = new Uint16Array(textBuf);
    inputChannelAvailable = true;
    // Handoff dos buffers: precisa ser um postMessage "cru" (não JSON string),
    // já que SharedArrayBuffer não pode ser serializado em texto.
    self.postMessage({
      type: "input-channel",
      available: true,
      controlBuffer: controlBuf,
      textBuffer: textBuf,
      maxChars: MAX_INPUT_CHARS,
    });
  } catch (err) {
    inputChannelAvailable = false;
    self.postMessage({ type: "input-channel", available: false });
  }
})();

// Exposto ao Python via `js.requestInputSync(prompt)`. Bloqueia de verdade
// a thread do worker até o usuário digitar e apertar Enter no campo inline.
self.requestInputSync = function (promptText) {
  if (!inputChannelAvailable) {
    // Sem isolamento de origem cruzada não há como bloquear de verdade.
    // Sinaliza EOF pro Python em vez de travar o worker sem saída.
    post({
      type: "stderr",
      text: "input() indisponível: o isolamento de origem cruzada (COOP/COEP) ainda não está ativo nesta página. Recarregue e tente novamente.\n",
    });
    return null;
  }
  Atomics.store(sharedControl, 0, STATUS_PENDING);
  Atomics.store(sharedControl, 1, 0);
  post({ type: "input-request", prompt: promptText || "" });
  Atomics.wait(sharedControl, 0, STATUS_PENDING); // bloqueia até status virar STATUS_READY
  const len = Atomics.load(sharedControl, 1);
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(sharedText[i]);
  Atomics.store(sharedControl, 0, STATUS_IDLE);
  return out;
};

// ---- Código Python que define o runtime + o shim de tkinter ----
const PY_RUNTIME = `
import sys, json, traceback
import js

def _post(d):
    js.dispatchPyEvent(json.dumps(d))

class _JSStream:
    def __init__(self, kind):
        self.kind = kind
    def write(self, s):
        if s:
            _post({"type": self.kind, "text": s})
        return len(s)
    def flush(self):
        pass

def _blocking_input(prompt=""):
    # O prompt e o texto digitado já são mostrados pela UI (campo inline no
    # terminal) do lado JS — o Python não precisa (nem deve) escrever nada
    # em stdout aqui, senão duplicaria a linha.
    line = js.requestInputSync(str(prompt))
    if line is None:
        raise EOFError("EOF ao ler input() (isolamento de origem cruzada indisponível)")
    return str(line)

import builtins
builtins.input = _blocking_input

_user_globals = {}

_next_id = [0]
def _new_id():
    _next_id[0] += 1
    return "w%d" % _next_id[0]

_widgets = {}     # id -> widget instance
_callbacks = {}    # callback id -> python callable
_vars = {}         # var id -> Variable instance

def _reg_callback(fn):
    if fn is None:
        return None
    cid = _new_id()
    _callbacks[cid] = fn
    return cid

class Variable:
    _kind = "string"
    def __init__(self, master=None, value=None, name=None):
        self._id = name or _new_id()
        self._value = value if value is not None else self._default()
        _vars[self._id] = self
    def _default(self):
        return ""
    def get(self):
        return self._value
    def set(self, v):
        self._value = v
        _post({"type": "var-set", "id": self._id, "value": v})
    def trace_add(self, *a, **k):
        pass

class StringVar(Variable):
    def _default(self): return ""

class IntVar(Variable):
    def _default(self): return 0

class DoubleVar(Variable):
    def _default(self): return 0.0

class BooleanVar(Variable):
    def _default(self): return False

class _Widget:
    _wtype = "widget"
    def __init__(self, master=None, **kw):
        self._id = _new_id()
        self._master = master
        self._parent_id = master._id if isinstance(master, _Widget) else "root"
        self._props = dict(kw)
        self._geometry = None
        self._children = []
        _widgets[self._id] = self
        if isinstance(master, _Widget):
            master._children.append(self)
        self._emit()

    def _emit(self):
        props = {}
        for k, v in self._props.items():
            if k == "command":
                props["_command_cb"] = _reg_callback(v)
            elif k == "textvariable" and isinstance(v, Variable):
                props["_var_id"] = v._id
                props["text"] = v.get()
            elif k in ("variable",) and isinstance(v, Variable):
                props["_var_id"] = v._id
            elif isinstance(v, Variable):
                props[k] = v.get()
            elif callable(v):
                props[k] = _reg_callback(v)
            else:
                props[k] = v
        _post({
            "type": "gui-widget",
            "id": self._id,
            "wtype": self._wtype,
            "parent": self._parent_id,
            "props": props,
            "geometry": self._geometry,
        })

    def config(self, **kw):
        self._props.update(kw)
        self._emit()
    configure = config

    def cget(self, key):
        return self._props.get(key)

    def __getitem__(self, key):
        return self.cget(key)
    def __setitem__(self, key, val):
        self.config(**{key: val})

    def pack(self, **kw):
        self._geometry = {"manager": "pack", "opts": kw}
        self._emit()
    def grid(self, **kw):
        self._geometry = {"manager": "grid", "opts": kw}
        self._emit()
    def place(self, **kw):
        self._geometry = {"manager": "place", "opts": kw}
        self._emit()
    def pack_forget(self):
        self._geometry = None
        self._emit()
    grid_forget = pack_forget
    place_forget = pack_forget

    def destroy(self):
        _post({"type": "gui-destroy", "id": self._id})
        _widgets.pop(self._id, None)

    def bind(self, event, func, add=None):
        cid = _reg_callback(func)
        _post({"type": "gui-bind", "id": self._id, "event": event, "cb": cid})

    def focus_set(self):
        _post({"type": "gui-focus", "id": self._id})

    def winfo_children(self):
        return list(self._children)

    def register(self, func):
        cid = _reg_callback(func)
        return "@@cb:" + cid

    def winfo_screenwidth(self):
        # Não existe "screen" dentro de um Web Worker (só na thread
        # principal), então usamos um valor best-effort fixo.
        return 1920

    def winfo_screenheight(self):
        return 1080

    def winfo_width(self):
        w = self._props.get("_width")
        return int(w) if w else 1

    def winfo_height(self):
        h = self._props.get("_height")
        return int(h) if h else 1

    def winfo_reqwidth(self):
        return self.winfo_width()

    def winfo_reqheight(self):
        return self.winfo_height()

    def winfo_x(self):
        return 0

    def winfo_y(self):
        return 0

    def update(self):
        pass

    def update_idletasks(self):
        pass


class Tk(_Widget):
    _wtype = "root"
    def __init__(self, *a, **kw):
        self._id = "root"
        self._master = None
        self._parent_id = None
        self._props = dict(kw)
        self._geometry = None
        self._children = []
        _widgets["root"] = self
        _post({"type": "gui-init"})
        self._emit()
    def title(self, t=None):
        if t is not None:
            self._props["title"] = t
            _post({"type": "gui-title", "text": t})
    def geometry(self, spec=None):
        if spec:
            try:
                wh = spec.split("+")[0].split("-")[0]
                w, h = wh.lower().split("x")
                self._props["_width"] = int(w)
                self._props["_height"] = int(h)
                self._emit()
            except Exception:
                pass
        return None
    def resizable(self, *a, **k):
        pass
    def mainloop(self, *a, **k):
        pass
    def quit(self):
        pass
    def destroy(self):
        _post({"type": "gui-destroy", "id": "root"})
    def update(self):
        pass
    def update_idletasks(self):
        pass

Toplevel = Tk

class Frame(_Widget):
    _wtype = "frame"

class Label(_Widget):
    _wtype = "label"

class Button(_Widget):
    _wtype = "button"

class Entry(_Widget):
    _wtype = "entry"
    def get(self):
        v = self._props.get("textvariable")
        if isinstance(v, Variable):
            return v.get()
        return self._props.get("_text", "")
    def insert(self, index, text):
        cur = self._props.get("_text", "")
        self._props["_text"] = cur + text
        self._props["_insert"] = text
        self._emit()
    def delete(self, first, last=None):
        self._props["_text"] = ""
        self._props["_clear"] = True
        self._emit()

class Text(_Widget):
    _wtype = "text"
    def get(self, start="1.0", end="end"):
        return self._props.get("_text", "")
    def insert(self, index, text):
        cur = self._props.get("_text", "")
        self._props["_text"] = cur + text
        self._emit()
    def delete(self, start, end=None):
        self._props["_text"] = ""
        self._emit()

class Checkbutton(_Widget):
    _wtype = "checkbutton"

class Radiobutton(_Widget):
    _wtype = "radiobutton"

class Scale(_Widget):
    _wtype = "scale"
    def get(self):
        v = self._props.get("variable")
        if isinstance(v, Variable):
            return v.get()
        return self._props.get("_value", 0)

class Listbox(_Widget):
    _wtype = "listbox"
    def insert(self, index, *items):
        cur = self._props.get("_items", [])
        cur = list(cur) + list(items)
        self._props["_items"] = cur
        self._emit()
    def delete(self, first, last=None):
        self._props["_items"] = []
        self._emit()
    def curselection(self):
        return self._props.get("_selection", ())
    def get(self, first, last=None):
        items = self._props.get("_items", [])
        if isinstance(first, int) and first < len(items):
            return items[first]
        return ""

class Canvas(_Widget):
    _wtype = "canvas"
    def __init__(self, master=None, **kw):
        self._ops = []
        super().__init__(master, **kw)
    def _add(self, op):
        oid = _new_id()
        op["id"] = oid
        self._ops.append(op)
        self._props["_ops"] = self._ops
        self._emit()
        return oid
    def create_line(self, *coords, **kw):
        return self._add({"op": "line", "coords": coords, "opts": kw})
    def create_rectangle(self, *coords, **kw):
        return self._add({"op": "rect", "coords": coords, "opts": kw})
    def create_oval(self, *coords, **kw):
        return self._add({"op": "oval", "coords": coords, "opts": kw})
    def create_text(self, *coords, **kw):
        return self._add({"op": "text", "coords": coords, "opts": kw})
    def create_polygon(self, *coords, **kw):
        return self._add({"op": "polygon", "coords": coords, "opts": kw})
    def delete(self, item="all"):
        if item == "all":
            self._ops = []
        else:
            self._ops = [o for o in self._ops if o["id"] != item]
        self._props["_ops"] = self._ops
        self._emit()

# ---- messagebox ----
class _messagebox:
    @staticmethod
    def showinfo(title=None, message=None, **kw):
        pass
    @staticmethod
    def showwarning(title=None, message=None, **kw):
        pass
    @staticmethod
    def showerror(title=None, message=None, **kw):
        pass
    @staticmethod
    def askyesno(title=None, message=None, **kw):
        return True
    @staticmethod
    def askokcancel(title=None, message=None, **kw):
        return True

messagebox = _messagebox()

# Constantes usadas comumente
TOP="top"; BOTTOM="bottom"; LEFT="left"; RIGHT="right"
X="x"; Y="y"; BOTH="both"; NONE="none"
W="w"; E="e"; N="n"; S="s"; NW="nw"; NE="ne"; SW="sw"; SE="se"; CENTER="center"
END="end"; INSERT="insert"
HORIZONTAL="horizontal"; VERTICAL="vertical"

import types
_mod = types.ModuleType("tkinter")
for _name, _val in list(globals().items()):
    if not _name.startswith("_"):
        setattr(_mod, _name, _val)
sys.modules["tkinter"] = _mod

_mbmod = types.ModuleType("tkinter.messagebox")
_mbmod.showinfo = _messagebox.showinfo
_mbmod.showwarning = _messagebox.showwarning
_mbmod.showerror = _messagebox.showerror
_mbmod.askyesno = _messagebox.askyesno
_mbmod.askokcancel = _messagebox.askokcancel
sys.modules["tkinter.messagebox"] = _mbmod
_mod.messagebox = _mbmod

_ttkmod = types.ModuleType("tkinter.ttk")
for _name in ("Frame","Label","Button","Entry","Checkbutton","Radiobutton","Scale"):
    setattr(_ttkmod, _name, globals()[_name])
sys.modules["tkinter.ttk"] = _ttkmod
_mod.ttk = _ttkmod


def run_user_code(code):
    global _user_globals, _widgets, _callbacks, _vars, _next_id
    _widgets = {}
    _callbacks = {}
    _vars = {}
    _next_id[0] = 0
    _user_globals = {"__name__": "__main__"}
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout = _JSStream("stdout")
    sys.stderr = _JSStream("stderr")
    try:
        exec(compile(code, "main.py", "exec"), _user_globals)
    except SystemExit:
        pass
    except Exception:
        tb = traceback.format_exc()
        _post({"type": "stderr", "text": tb})
    finally:
        sys.stdout, sys.stderr = old_out, old_err
    _post({"type": "run-end"})


def handle_gui_event(raw):
    data = json.loads(raw)
    kind = data.get("kind")
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout = _JSStream("stdout")
    sys.stderr = _JSStream("stderr")
    try:
        if kind == "var-update":
            v = _vars.get(data["id"])
            if v is not None:
                v._value = data["value"]
        elif kind == "entry-text":
            w = _widgets.get(data.get("id"))
            if w is not None:
                w._props["_text"] = data.get("value", "")
        elif kind == "text-content":
            w = _widgets.get(data.get("id"))
            if w is not None:
                w._props["_text"] = data.get("value", "")
        elif kind == "listbox-select":
            w = _widgets.get(data.get("id"))
            if w is not None:
                w._props["_selection"] = tuple(data.get("indices", []))
        elif kind == "validate":
            cb = _callbacks.get(data.get("cb"))
            ok = True
            if cb:
                try:
                    ok = bool(cb(data.get("value", "")))
                except Exception:
                    _post({"type": "stderr", "text": traceback.format_exc()})
                    ok = True
            _post({
                "type": "validate-result",
                "id": data.get("targetId"),
                "valid": ok,
                "value": data.get("value", ""),
            })
            return
        cb = _callbacks.get(data.get("cb"))
        if cb:
            try:
                cb()
            except Exception:
                _post({"type": "stderr", "text": traceback.format_exc()})
    finally:
        sys.stdout, sys.stderr = old_out, old_err
`;

// ---------- Boot: carrega o Pyodide dentro do próprio Worker ----------
let pyodide = null;
let runUserCode = null;
let handleGuiEvent = null;

async function boot() {
  post({ type: "status", text: "Baixando Pyodide..." });
  importScripts(PYODIDE_CDN);
  pyodide = await loadPyodide();
  post({ type: "status", text: "Preparando runtime Python..." });
  await pyodide.runPythonAsync(PY_RUNTIME);
  runUserCode = pyodide.globals.get("run_user_code");
  handleGuiEvent = pyodide.globals.get("handle_gui_event");
  post({ type: "ready" });
}

self.onmessage = async (e) => {
  // O handoff inicial de buffers usa um objeto "cru" (não string), então
  // esse listener não precisa tratar mensagens vindas de nós mesmos — só
  // as que chegam do thread principal, que são sempre strings JSON.
  if (typeof e.data !== "string") return;
  let msg;
  try {
    msg = JSON.parse(e.data);
  } catch (err) {
    return;
  }

  if (msg.type === "run") {
    try {
      const pkgs = detectPackages(msg.code);
      for (const p of pkgs) {
        post({ type: "status", text: `Carregando pacote: ${p}...` });
        await pyodide.loadPackage(p);
      }
      post({ type: "run-start" });
      runUserCode(msg.code);
    } catch (err) {
      post({ type: "stderr", text: String(err) });
      post({ type: "run-end" });
    }
  } else if (msg.type === "gui-event") {
    try {
      handleGuiEvent(JSON.stringify(msg));
    } catch (err) {
      post({ type: "stderr", text: String(err) });
    }
  }
};

boot().catch((err) => {
  post({ type: "stderr", text: "Falha ao iniciar o Pyodide: " + String(err) });
});

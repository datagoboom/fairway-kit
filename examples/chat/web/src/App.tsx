/**
 * Fairway example app - MUI edition.
 *
 * Deliberately shows the "fully customized" end of the spectrum: no fairway
 * stylesheet, no default bubbles, no stock ChatInput. Fairway supplies only
 * behavior (ChatProvider/useChatContext state, ChatPanel's row merge +
 * stick-to-bottom, ChatItem's type dispatch); every visible pixel is MUI +
 * lucide icons. Compare with the previous commit for the zero-dependency look.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Alert,
  AppBar,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  CssBaseline,
  Drawer,
  GlobalStyles,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  TextField,
  ThemeProvider,
  Toolbar,
  Tooltip,
  Typography,
  createTheme,
} from "@mui/material";
import {
  Check,
  Minus,
  Paperclip,
  Plus,
  SendHorizontal,
  Settings as SettingsIcon,
  ShieldQuestion,
  Square,
  X,
} from "lucide-react";
import { AgentChatClient, type Attachment, type Session } from "@fairway-kit/client";
import {
  ChatItem,
  ChatPanel,
  ChatProvider,
  useChatContext,
  type ChatComponents,
  type ChatRow,
  type ItemComponentProps,
} from "@fairway-kit/client/react";
import { MarkdownText } from "@fairway-kit/client/react/markdown";
import type { ErrorItem, PermissionItem, TextItem, ToolItem } from "@fairway-kit/client";

const client = new AgentChatClient("/api/chat");

const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#7ab3e0" },
    background: { default: "#101214", paper: "#181c20" },
  },
  shape: { borderRadius: 10 },
  typography: { fontSize: 13.5 },
});

const SIDEBAR_WIDTH = 240;

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "settings">("chat");

  useEffect(() => {
    void client.listSessions().then(({ sessions }) => {
      setSessions(sessions);
      if (sessions.length > 0) setSessionId((cur) => cur ?? sessions[0].id);
    });
  }, []);

  const newSession = async () => {
    const { session } = await client.createSession(`chat ${new Date().toLocaleTimeString()}`);
    setSessions((cur) => [session, ...cur]);
    setSessionId(session.id);
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <GlobalStyles styles={markdownStyles} />
      <Box sx={{ display: "flex", height: "100vh" }}>
        <Drawer
          variant="permanent"
          sx={{
            width: SIDEBAR_WIDTH,
            "& .MuiDrawer-paper": { width: SIDEBAR_WIDTH, boxSizing: "border-box", p: 1.5 },
          }}
        >
          <Button variant="outlined" startIcon={<Plus size={16} />} onClick={newSession} fullWidth>
            New session
          </Button>
          <List dense sx={{ mt: 1 }}>
            {sessions.map((s) => (
              <ListItemButton
                key={s.id}
                selected={s.id === sessionId}
                onClick={() => setSessionId(s.id)}
                sx={{ borderRadius: 2 }}
              >
                <ListItemText
                  primary={s.name ?? s.id.slice(0, 8)}
                  slotProps={{ primary: { noWrap: true, sx: { fontSize: 13 } } }}
                />
              </ListItemButton>
            ))}
          </List>
        </Drawer>

        <Box component="main" sx={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <ChatProvider
            client={client}
            sessionId={sessionId}
            onError={setError}
            onExtensionEvent={(ev) => console.log("extension event", ev)}
          >
            <Header view={view} onToggleSettings={() => setView((v) => (v === "chat" ? "settings" : "chat"))} />
            {error && (
              <Alert severity="error" onClose={() => setError(null)} sx={{ borderRadius: 0 }}>
                {error}
              </Alert>
            )}
            {view === "settings" ? (
              <SettingsPage onClose={() => setView("chat")} />
            ) : (
              <>
                <Box sx={{ flex: 1, minHeight: 0 }}>
                  <ChatPanel
                    components={itemComponents}
                    jumpLabel={<Chip size="small" label="New messages" color="primary" clickable />}
                  >
                    {(row) => <MessageBubble row={row} />}
                  </ChatPanel>
                </Box>
                <Composer disabled={!sessionId} />
              </>
            )}
          </ChatProvider>
        </Box>
      </Box>
    </ThemeProvider>
  );
}

// -- header: app-owned, driven by useChatContext ------------------------------

function Header({ view, onToggleSettings }: { view: string; onToggleSettings: () => void }) {
  const { connection, streaming, stop } = useChatContext();
  const color =
    connection === "open" ? "success.main"
    : connection === "connecting" || connection === "reconnecting" ? "warning.main"
    : "text.disabled";
  return (
    <AppBar position="static" color="transparent" elevation={0} sx={{ borderBottom: 1, borderColor: "divider" }}>
      <Toolbar variant="dense" sx={{ gap: 1.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>fairway chat</Typography>
        <Tooltip title={`stream: ${connection}`}>
          <Box sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: color }} />
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        {streaming && (
          <Button
            size="small"
            color="error"
            variant="outlined"
            startIcon={<Square size={13} />}
            onClick={() => void stop()}
          >
            Stop
          </Button>
        )}
        <Tooltip title={view === "settings" ? "Back to chat" : "Settings"}>
          <IconButton onClick={onToggleSettings} color={view === "settings" ? "primary" : "default"}>
            <SettingsIcon size={18} />
          </IconButton>
        </Tooltip>
      </Toolbar>
    </AppBar>
  );
}

// -- settings page -------------------------------------------------------------

interface ServerSettings {
  runner: "claude" | "echo";
  model: string;
  auth: "inherit" | "subscription" | "api";
  permission_mode: "default" | "acceptEdits" | "bypassPermissions" | "dontAsk";
  tools: string[];
  allowed_tools: string[];
  system_prompt: string;
  max_turns: number;
}

function SettingsPage({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [knownTools, setKnownTools] = useState<string[]>([]);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setSettings(d.settings);
        setKnownTools(d.known_tools);
      })
      .catch((e) => setStatus({ kind: "err", msg: String(e) }));
  }, []);

  if (!settings) {
    return (
      <Box sx={{ p: 3 }}>
        {status ? <Alert severity="error">{status.msg}</Alert> : <CircularProgress size={20} />}
      </Box>
    );
  }

  const set = <K extends keyof ServerSettings>(key: K, value: ServerSettings[K]) =>
    setSettings((cur) => (cur ? { ...cur, [key]: value } : cur));

  const save = () => {
    setSaving(true);
    setStatus(null);
    void fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
        const d = await r.json();
        setSettings(d.settings);
        setStatus({ kind: "ok", msg: "Saved. New settings apply from the next message." });
      })
      .catch((e) => setStatus({ kind: "err", msg: String(e) }))
      .finally(() => setSaving(false));
  };

  const gated = settings.tools.filter((t) => !settings.allowed_tools.includes(t));
  const claude = settings.runner === "claude";

  return (
    <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: 3 }}>
      <Box sx={{ maxWidth: 640, mx: "auto", display: "flex", flexDirection: "column", gap: 2.5 }}>
        <Typography variant="h6">Settings</Typography>
        {status && (
          <Alert severity={status.kind === "ok" ? "success" : "error"} onClose={() => setStatus(null)}>
            {status.msg}
          </Alert>
        )}

        <TextField
          select
          label="Runner"
          value={settings.runner}
          onChange={(e) => set("runner", e.target.value as ServerSettings["runner"])}
          helperText="Echo mode needs no credentials and never calls a model"
        >
          <MenuItem value="claude">Claude Agent SDK</MenuItem>
          <MenuItem value="echo">Echo (offline)</MenuItem>
        </TextField>

        {claude && (
          <>
            <TextField
              label="Model"
              value={settings.model}
              onChange={(e) => set("model", e.target.value)}
              helperText='Model ID or alias, e.g. "claude-opus-4-8"'
            />
            <TextField
              select
              label="Auth mode"
              value={settings.auth}
              onChange={(e) => set("auth", e.target.value as ServerSettings["auth"])}
              helperText="How the Claude CLI authenticates: inherit the environment, force your subscription login, or force an API key"
            >
              <MenuItem value="inherit">Inherit environment</MenuItem>
              <MenuItem value="subscription">Subscription (claude login)</MenuItem>
              <MenuItem value="api">API key (ANTHROPIC_API_KEY)</MenuItem>
            </TextField>
            <TextField
              select
              label="Permission mode"
              value={settings.permission_mode}
              onChange={(e) => set("permission_mode", e.target.value as ServerSettings["permission_mode"])}
              helperText={
                settings.permission_mode === "bypassPermissions"
                  ? "Everything runs without asking. Fine for read-only tools, reckless with Write or Bash."
                  : "With 'default', tools outside the pre-approved set pause for inline approval in the chat"
              }
            >
              <MenuItem value="default">default (gate non-approved tools)</MenuItem>
              <MenuItem value="acceptEdits">acceptEdits</MenuItem>
              <MenuItem value="dontAsk">dontAsk (deny non-approved)</MenuItem>
              <MenuItem value="bypassPermissions">bypassPermissions</MenuItem>
            </TextField>
            <Autocomplete
              multiple
              options={knownTools}
              value={settings.tools}
              onChange={(_, v) => {
                set("tools", v);
                set("allowed_tools", settings.allowed_tools.filter((t) => v.includes(t)));
              }}
              renderInput={(p) => (
                <TextField {...p} label="Available tools" helperText="The outer boundary: tools not listed here do not exist for the agent" />
              )}
            />
            <Autocomplete
              multiple
              options={settings.tools}
              value={settings.allowed_tools}
              onChange={(_, v) => set("allowed_tools", v)}
              renderInput={(p) => (
                <TextField
                  {...p}
                  label="Pre-approved tools"
                  helperText={
                    gated.length > 0
                      ? `Run without asking. Currently gated: ${gated.join(", ")}`
                      : "Run without asking. Nothing is gated right now."
                  }
                />
              )}
            />
            <TextField
              label="System prompt"
              value={settings.system_prompt}
              onChange={(e) => set("system_prompt", e.target.value)}
              multiline
              minRows={3}
            />
            <TextField
              label="Max turns"
              type="number"
              value={settings.max_turns}
              onChange={(e) => set("max_turns", Math.max(1, Math.min(300, Number(e.target.value) || 1)))}
              helperText="Upper bound on agent loop iterations per message"
              sx={{ maxWidth: 200 }}
            />
          </>
        )}

        <Box sx={{ display: "flex", gap: 1.5 }}>
          <Button variant="contained" onClick={save} disabled={saving}>
            {saving ? "Saving" : "Save"}
          </Button>
          <Button variant="outlined" onClick={onClose}>
            Back to chat
          </Button>
        </Box>
        <Typography variant="caption" color="text.secondary">
          Settings persist to a JSON file next to the server and apply to the next
          message. In-flight turns keep the configuration they started with.
        </Typography>
      </Box>
    </Box>
  );
}

// -- messages: render prop owns the bubble, ChatItem dispatches item types ----

function MessageBubble({ row }: { row: ChatRow }) {
  const user = row.role === "user";
  return (
    <Box sx={{ display: "flex", justifyContent: user ? "flex-end" : "flex-start", px: 2, py: 0.6 }}>
      <Paper
        variant="outlined"
        sx={{
          maxWidth: "72%",
          px: 1.8,
          py: 1.2,
          display: "flex",
          flexDirection: "column",
          gap: 0.8,
          bgcolor: user ? "primary.dark" : "background.paper",
          borderColor: row.live ? "success.dark" : "divider",
          overflowWrap: "anywhere",
        }}
      >
        {row.message?.attachments && row.message.attachments.length > 0 && (
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.8 }}>
            {row.message.attachments.map((a) =>
              a.media_type.startsWith("image/") ? (
                <Box
                  key={a.id}
                  component="img"
                  src={client.attachmentUrl(a.id)}
                  alt={a.name}
                  sx={{ maxWidth: 220, maxHeight: 160, borderRadius: 2, border: 1, borderColor: "divider" }}
                />
              ) : (
                <Chip
                  key={a.id}
                  size="small"
                  variant="outlined"
                  label={a.name}
                  component="a"
                  href={client.attachmentUrl(a.id)}
                  target="_blank"
                  clickable
                />
              )
            )}
          </Box>
        )}
        {row.items.map((item, i) => (
          <ChatItem key={i} item={item} row={row} components={itemComponents} />
        ))}
        {row.typing && <TypingDots />}
      </Paper>
    </Box>
  );
}

/** MUI-styled bouncing dots (the library's TypingIndicator works too - this
 * shows a themed custom one). */
function TypingDots() {
  return (
    <Box sx={{ display: "inline-flex", gap: "5px", py: 0.5 }} aria-label="Assistant is working">
      {[0, 1, 2].map((i) => (
        <Box
          key={i}
          sx={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            bgcolor: "text.secondary",
            animation: "fw-bounce 1.2s ease-in-out infinite",
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </Box>
  );
}

const TOOL_STATUS: Record<string, { icon: ReactNode; color: "default" | "success" | "error" | "warning" }> = {
  running: { icon: <CircularProgress size={12} thickness={6} />, color: "default" },
  ok: { icon: <Check size={14} />, color: "success" },
  err: { icon: <X size={14} />, color: "error" },
  interrupted: { icon: <Minus size={14} />, color: "warning" },
};

function ToolChip({ item }: ItemComponentProps<ToolItem>) {
  const s = TOOL_STATUS[item.status] ?? TOOL_STATUS.running;
  const label = [item.label ?? item.tool ?? item.id, item.detail ?? item.summary]
    .filter(Boolean)
    .join(" · ");
  return (
    <Chip
      size="small"
      icon={<Box sx={{ display: "inline-flex", alignItems: "center", pl: 0.5 }}>{s.icon}</Box>}
      color={s.color}
      variant="outlined"
      label={label}
      sx={{ alignSelf: "flex-start", maxWidth: "100%" }}
    />
  );
}

function ThinkingText({ item }: ItemComponentProps<TextItem>) {
  return (
    <Typography variant="body2" sx={{ color: "text.secondary", fontStyle: "italic", whiteSpace: "pre-wrap" }}>
      {item.content}
    </Typography>
  );
}

function ErrorAlert({ item }: ItemComponentProps<ErrorItem>) {
  return <Alert severity="error" variant="outlined">{item.message}</Alert>;
}

/** MUI take on the inline approval card (the library ships a default too). */
function PermissionCard({ item }: ItemComponentProps<PermissionItem>) {
  const { respondPermission } = useChatContext();
  const decide = (d: "allow" | "allow_session" | "deny") =>
    void respondPermission(item.id, d).catch(() => undefined);
  const pending = item.status === "pending";
  return (
    <Paper
      variant="outlined"
      sx={{
        px: 1.5, py: 1, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1,
        borderStyle: pending ? "dashed" : "solid",
        borderColor: item.status === "allowed" ? "success.dark"
          : item.status === "denied" ? "error.dark"
          : pending ? "warning.dark" : "divider",
        bgcolor: "background.default",
      }}
    >
      <ShieldQuestion size={16} />
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {item.label ?? item.tool}
      </Typography>
      {item.detail && (
        <Typography variant="body2" color="text.secondary" noWrap sx={{ maxWidth: 260 }}>
          {item.detail}
        </Typography>
      )}
      <Box sx={{ flex: 1 }} />
      {pending ? (
        <Box sx={{ display: "flex", gap: 0.8 }}>
          <Button size="small" variant="outlined" color="success" onClick={() => decide("allow")}>
            Allow
          </Button>
          <Button size="small" variant="outlined" onClick={() => decide("allow_session")}>
            Always allow
          </Button>
          <Button size="small" variant="outlined" color="error" onClick={() => decide("deny")}>
            Deny
          </Button>
        </Box>
      ) : (
        <Typography variant="caption" color="text.secondary">
          {item.status === "allowed"
            ? item.scope === "session" ? "allowed for session" : "allowed"
            : item.status}
        </Typography>
      )}
    </Paper>
  );
}

const itemComponents: ChatComponents = {
  Text: MarkdownText,
  Tool: ToolChip,
  Thinking: ThinkingText,
  Permission: PermissionCard,
  Error: ErrorAlert,
};

// -- composer: fully custom, replaces ChatInput -------------------------------

function Composer({ disabled }: { disabled: boolean }) {
  const { client, sessionId, send, stop, streaming } = useChatContext();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const busy = streaming || uploading;

  const submit = () => {
    const t = text.trim();
    if ((!t && files.length === 0) || busy || disabled || !sessionId) return;
    const pending = files;
    setText("");
    setFiles([]);
    setUploading(true);
    void (async () => {
      const refs: Attachment[] = [];
      for (const f of pending) refs.push(await client.uploadAttachment(sessionId, f));
      await send(t, refs.length > 0 ? refs : undefined);
    })()
      .catch(() => {
        setText(t);
        setFiles(pending);
      })
      .finally(() => setUploading(false));
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", borderTop: 1, borderColor: "divider" }}>
      {files.length > 0 && (
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.8, px: 1.5, pt: 1 }}>
          {files.map((f, i) => (
            <Chip
              key={i}
              size="small"
              label={f.name}
              onDelete={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
              deleteIcon={<X size={14} />}
            />
          ))}
        </Box>
      )}
      <Box sx={{ display: "flex", gap: 1, p: 1.5 }}>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          setFiles((cur) => [...cur, ...Array.from(e.target.files ?? [])]);
          if (fileInput.current) fileInput.current.value = "";
        }}
      />
      <Tooltip title="Attach files">
        <span>
          <IconButton disabled={disabled || busy} onClick={() => fileInput.current?.click()}>
            <Paperclip size={18} />
          </IconButton>
        </span>
      </Tooltip>
      <TextField
        fullWidth
        size="small"
        autoFocus
        placeholder={disabled ? "Create a session to start" : "Message the agent"}
        value={text}
        disabled={disabled || busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      {streaming ? (
        <Tooltip title="Stop">
          <IconButton color="error" onClick={() => void stop()}>
            <Square size={18} />
          </IconButton>
        </Tooltip>
      ) : (
        <Tooltip title="Send">
          <span>
            <IconButton
              color="primary"
              onClick={submit}
              disabled={disabled || busy || (!text.trim() && files.length === 0)}
            >
              <SendHorizontal size={18} />
            </IconButton>
          </span>
        </Tooltip>
      )}
      </Box>
    </Box>
  );
}

// -- markdown styling (MarkdownText emits [data-markdown]) --------------------

const markdownStyles = {
  "@keyframes fw-bounce": {
    "0%, 60%, 100%": { transform: "none", opacity: 0.4 },
    "30%": { transform: "translateY(-4px)", opacity: 1 },
  },
  "[data-markdown] > *:not(:last-child)": { marginBottom: "0.6em" },
  "[data-markdown] h1, [data-markdown] h2, [data-markdown] h3, [data-markdown] h4": {
    fontSize: "1.05em",
    marginTop: "0.4em",
  },
  "[data-markdown] ul, [data-markdown] ol": { paddingLeft: "1.4em" },
  "[data-markdown] li + li": { marginTop: "0.2em" },
  "[data-markdown] code": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.9em",
    background: "#262b31",
    padding: "1px 5px",
    borderRadius: 4,
  },
  "[data-markdown] pre": {
    background: "#0b0d0f",
    border: "1px solid #2a2e33",
    borderRadius: 8,
    padding: "10px 12px",
    overflowX: "auto" as const,
  },
  "[data-markdown] pre code": { background: "none", padding: 0, fontSize: "0.85em" },
  "[data-markdown] blockquote": {
    borderLeft: "3px solid #3a4a5a",
    paddingLeft: 10,
    color: "#a7b0ba",
  },
  "[data-markdown] a": { color: "#7ab3e0" },
  "[data-markdown] table": { borderCollapse: "collapse" as const },
  "[data-markdown] th, [data-markdown] td": {
    border: "1px solid #2a2e33",
    padding: "4px 10px",
    fontSize: 13,
  },
  "[data-markdown] hr": { border: "none", borderTop: "1px solid #2a2e33" },
};

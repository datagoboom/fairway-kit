/**
 * Fairway example app — MUI edition.
 *
 * Deliberately shows the "fully customized" end of the spectrum: no fairway
 * stylesheet, no default bubbles, no stock ChatInput. Fairway supplies only
 * behavior (ChatProvider/useChatContext state, ChatPanel's row merge +
 * stick-to-bottom, ChatItem's type dispatch); every visible pixel is MUI +
 * lucide icons. Compare with the previous commit for the zero-dependency look.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Alert,
  AppBar,
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
  Paper,
  TextField,
  ThemeProvider,
  Toolbar,
  Tooltip,
  Typography,
  createTheme,
} from "@mui/material";
import { Check, Minus, Plus, SendHorizontal, Square, X } from "lucide-react";
import { AgentChatClient, type Session } from "fairway-kit";
import {
  ChatItem,
  ChatPanel,
  ChatProvider,
  useChatContext,
  type ChatComponents,
  type ChatRow,
  type ItemComponentProps,
} from "fairway-kit/react";
import { MarkdownText } from "fairway-kit/react/markdown";
import type { ErrorItem, TextItem, ToolItem } from "fairway-kit";

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
            <Header />
            {error && (
              <Alert severity="error" onClose={() => setError(null)} sx={{ borderRadius: 0 }}>
                {error}
              </Alert>
            )}
            <Box sx={{ flex: 1, minHeight: 0 }}>
              <ChatPanel
                components={itemComponents}
                jumpLabel={<Chip size="small" label="New messages" color="primary" clickable />}
              >
                {(row) => <MessageBubble row={row} />}
              </ChatPanel>
            </Box>
            <Composer disabled={!sessionId} />
          </ChatProvider>
        </Box>
      </Box>
    </ThemeProvider>
  );
}

// -- header: app-owned, driven by useChatContext ------------------------------

function Header() {
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
      </Toolbar>
    </AppBar>
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
        {row.items.map((item, i) => (
          <ChatItem key={i} item={item} row={row} components={itemComponents} />
        ))}
        {row.typing && <TypingDots />}
      </Paper>
    </Box>
  );
}

/** MUI-styled bouncing dots (the library's TypingIndicator works too — this
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

const itemComponents: ChatComponents = {
  Text: MarkdownText,
  Tool: ToolChip,
  Thinking: ThinkingText,
  Error: ErrorAlert,
};

// -- composer: fully custom, replaces ChatInput -------------------------------

function Composer({ disabled }: { disabled: boolean }) {
  const { send, stop, streaming } = useChatContext();
  const [text, setText] = useState("");

  const submit = () => {
    const t = text.trim();
    if (!t || streaming || disabled) return;
    setText("");
    void send(t).catch(() => setText(t)); // restore draft on failure
  };

  return (
    <Box sx={{ display: "flex", gap: 1, p: 1.5, borderTop: 1, borderColor: "divider" }}>
      <TextField
        fullWidth
        size="small"
        autoFocus
        placeholder={disabled ? "Create a session to start" : "Message the agent"}
        value={text}
        disabled={disabled || streaming}
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
            <IconButton color="primary" onClick={submit} disabled={disabled || !text.trim()}>
              <SendHorizontal size={18} />
            </IconButton>
          </span>
        </Tooltip>
      )}
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

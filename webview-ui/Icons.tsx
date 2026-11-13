// Icons come from lucide (the set shadcn uses), sized to the text around them.
// Each AI tool shows its own logo (LobeHub's icon set, MIT; the marks belong to their owners).
import { type LucideProps } from "lucide-react";
import claudeLogo from "@lobehub/icons-static-svg/icons/claude-color.svg";
import codexLogo from "@lobehub/icons-static-svg/icons/codex-color.svg";
import geminiLogo from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import type { Status, Tool } from "../src/core/types";
import { STATUS_LABEL } from "./api";

export {
  Activity,
  ArrowUpRight,
  Eraser,
  Keyboard,
  Scan,
  ListFilter,
  Folder,
  FolderOpen,
  FolderTree,
  FolderX,
  SearchX,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  BarChart3,
  Bell,
  CalendarDays,
  ChevronDown,
  Network,
  Check,
  ChevronRight,
  Clock,
  Coins,
  ExternalLink,
  GitBranch,
  Inbox,
  LayoutGrid,
  Link2,
  Maximize2,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Eye,
  LayoutDashboard,
  MessageSquareDot,
  Minimize2,
  Search,
  SquareTerminal,
  Unlink,
  Wand2,
  X,
  Zap,
} from "lucide-react";

/** Default props for an icon inline with text. */
export const I: LucideProps = { size: 14, strokeWidth: 2, "aria-hidden": true };

const LOGO: Record<Tool, string> = { Claude: claudeLogo, Codex: codexLogo, Gemini: geminiLogo };

/** The tool's own logo. The SVGs are bundled files from the icon set, never user content. */
export function ToolMark({ tool, size = 16 }: { tool: Tool; size?: number }) {
  return <span className="toolmark" style={{ fontSize: size }} role="img" aria-label={tool} dangerouslySetInnerHTML={{ __html: LOGO[tool] }} />;
}

export function StatusDot({ status }: { status: Status }) {
  return <span className={`dot ${status}`} role="img" aria-label={STATUS_LABEL[status]} />;
}

export function StatusChip({ status }: { status: Status }) {
  return (
    <span className={`statuschip ${status}`}>
      <span className={`dot ${status}`} aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

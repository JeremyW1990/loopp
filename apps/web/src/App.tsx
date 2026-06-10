import { Link, Route, Routes, useLocation } from "react-router-dom";
import ChatPage from "./pages/ChatPage";
import { trpc } from "./trpc";

function StatsCard() {
  const stats = trpc.system.stats.useQuery();

  if (stats.isError) {
    return (
      <p className="text-sm text-red-600">
        API unreachable — is the server running? ({stats.error.message})
      </p>
    );
  }
  if (!stats.data) {
    return <p className="text-sm text-slate-500">Checking database…</p>;
  }
  return (
    <div className="flex gap-6 text-sm text-slate-600">
      <span>
        <strong className="text-slate-900">{stats.data.customers}</strong>{" "}
        customers
      </span>
      <span>
        <strong className="text-slate-900">{stats.data.orders}</strong> orders
      </span>
      <span>
        <strong className="text-slate-900">{stats.data.orderItems}</strong>{" "}
        items
      </span>
      <span>
        <strong className="text-slate-900">{stats.data.refunds}</strong>{" "}
        refunds
      </span>
    </div>
  );
}

function AdminPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-900">
        Admin dashboard
      </h1>
      <p className="text-slate-500">
        Agent traces, escalations, and controls land here in milestone 5.
      </p>
      <StatsCard />
    </div>
  );
}

export default function App() {
  const { pathname } = useLocation();
  const tab = (to: string, label: string) => (
    <Link
      to={to}
      className={`rounded-md px-3 py-1.5 text-sm font-medium ${
        pathname === to
          ? "bg-slate-900 text-white"
          : "text-slate-600 hover:bg-slate-200"
      }`}
    >
      {label}
    </Link>
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <span className="font-semibold tracking-tight text-slate-900">
            Loopp · Refund Support
          </span>
          <nav className="flex gap-1">
            {tab("/", "Chat")}
            {tab("/admin", "Admin")}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10">
        <Routes>
          <Route path="/" element={<ChatPage />} />
          <Route path="/admin" element={<AdminPage />} />
        </Routes>
      </main>
    </div>
  );
}

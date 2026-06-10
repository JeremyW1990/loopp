import { Link, Route, Routes, useLocation } from "react-router-dom";
import AdminPage from "./pages/AdminPage";
import ChatPage from "./pages/ChatPage";

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

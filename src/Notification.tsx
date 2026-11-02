import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";

export type NotificationStatus =
  | "info"
  | "success"
  | "error"
  | "error_code"
  | "warning"
  | "new_update_launcher"
  | "loading_download"
  | "cancel_install_instance"
  | "cancel_install_mod";

export type NotificationData = {
  id: string;
  title: string;
  message: string;
  status: NotificationStatus;
  duration?: number; // ms, null = persistent
  progress?: number; // 0-100 percentage
  action?: { label: string; onClick: () => void };
};

type CSSVars = CSSProperties & { [key: `--${string}`]: string | number };

const statusConfig: Record<NotificationStatus, { icon: string; color: string }> = {
  info: { icon: "ℹ", color: "#3b82f6" },
  success: { icon: "✓", color: "#10b981" },
  error: { icon: "✕", color: "#ef4444" },
  error_code: { icon: "✕", color: "#dc2626" },
  warning: { icon: "⚠", color: "#f59e0b" },
  new_update_launcher: { icon: "↓", color: "#8b5cf6" },
  loading_download: { icon: "↻", color: "#06b6d4" },
  cancel_install_instance: { icon: "✕", color: "#ef4444" },
  cancel_install_mod: { icon: "✕", color: "#ef4444" },
};

export function NotificationContainer({
  position,
}: {
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}) {
  const [notifications, setNotifications] = useState<NotificationData[]>([]);

  useEffect(() => {
    // Listen to Tauri events
    const unNotification = listen<NotificationData>("notification", (e) => {
      const notif = e.payload;
      const id = notif.id || `${Date.now()}-${Math.random()}`;
      const withId = { ...notif, id };
      
      setNotifications((prev) => {
        // Prevent duplicates
        if (prev.some((n) => n.id === id)) return prev;
        return [...prev, withId];
      });

      if (notif.duration !== null && notif.duration !== undefined) {
        setTimeout(() => {
          setNotifications((prev) => prev.filter((n) => n.id !== id));
        }, notif.duration);
      }
    });

    // Listen to window custom events (from DownloadOverlay)
    const handleWindowNotif = (e: Event) => {
      const notif = (e as CustomEvent).detail as NotificationData;
      const id = notif.id || `${Date.now()}-${Math.random()}`;
      const withId = { ...notif, id };
      
      setNotifications((prev) => {
        // Prevent duplicates
        if (prev.some((n) => n.id === id)) return prev;
        return [...prev, withId];
      });

      if (notif.duration !== null && notif.duration !== undefined) {
        setTimeout(() => {
          setNotifications((prev) => prev.filter((n) => n.id !== id));
        }, notif.duration);
      }
    };

    window.addEventListener("notification", handleWindowNotif);

    return () => {
      unNotification.then((f) => f());
      window.removeEventListener("notification", handleWindowNotif);
    };
  }, []);

  const dismiss = (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  };

  const positionStyle: CSSProperties =
    position === "top-left"
      ? { top: 18, left: 18 }
      : position === "top-right"
        ? { top: 18, right: 18 }
        : position === "bottom-left"
          ? { bottom: 18, left: 18 }
          : { bottom: 18, right: 18 };

  if (notifications.length === 0) return null;

  return (
    <div
      className="notification-stack"
      style={positionStyle as CSSVars}
    >
      {notifications.map((notif) => {
        const cfg = statusConfig[notif.status];
        const isLoading = notif.status === "loading_download";

        return (
          <div
            key={notif.id}
            className={"notification " + notif.status}
            style={{
              "--notif-color": cfg.color,
              "--notif-icon": `"${cfg.icon}"`,
            } as CSSVars}
          >
            <div className="notif-header">
              <span className={`notif-icon${isLoading ? " loading" : ""}`} />
              <div className="notif-content">
                <h4>{notif.title}</h4>
                <p>{notif.message}</p>
                {notif.progress != null && (
                  <div className="notif-progress">
                    <div className="notif-progress-bar" style={{ width: `${notif.progress}%` }} />
                  </div>
                )}
              </div>
              <button
                className="notif-close"
                onClick={() => dismiss(notif.id)}
                aria-label="Close notification"
              >
                ✕
              </button>
            </div>
            {notif.action && (
              <button
                className="notif-action"
                onClick={() => {
                  notif.action!.onClick();
                  dismiss(notif.id);
                }}
              >
                {notif.action.label}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

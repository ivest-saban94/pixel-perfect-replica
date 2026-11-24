import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, Link, createRootRouteWithContext, useRouter, HeadContent, Scripts, type ErrorComponentProps } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { FieldProvider } from "@/components/field/FieldContext";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-center">
      <div><h1 className="text-7xl font-black">404</h1>
        <Link to="/" className="btn-field mt-6 border-primary bg-primary text-primary-foreground">בית</Link></div>
    </div>
  );
}
function ErrorComponent({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  useEffect(() => { reportLovableError(error, { boundary: "tanstack_root_error_component" }); }, [error]);
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-center">
      <div><h1 className="text-2xl font-bold">שגיאה בטעינה</h1>
        <button onClick={() => { router.invalidate(); reset(); }} className="btn-field mt-6 border-primary bg-primary text-primary-foreground">נסה שוב</button></div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" },
      { name: "theme-color", content: "#14171c" },
      { title: "סבן שטח – אפליקציית נהגים" },
      { name: "description", content: "אפליקציית שטח לנהגי ח. סבן חומרי בניין" },
      { property: "og:title", content: "סבן שטח – אפליקציית נהגים" },
      { property: "og:description", content: "אפליקציית שטח לנהגי ח. סבן חומרי בניין" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Rubik:wght@400;700;900&display=swap" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (<html lang="he" dir="rtl"><head><HeadContent /></head><body>{children}<Scripts /></body></html>);
}
function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (<QueryClientProvider client={queryClient}><FieldProvider><Outlet /></FieldProvider></QueryClientProvider>);
}

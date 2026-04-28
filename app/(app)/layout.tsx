export default function StudioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="dark min-h-svh bg-background text-foreground">
      {children}
    </div>
  );
}

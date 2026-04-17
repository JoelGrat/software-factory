import { FileText } from "lucide-react";

export default function DocsPage({
  params,
}: {
  params: { projectId: string };
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center h-full p-8">
      <div className="flex flex-col items-center gap-4 text-center max-w-md">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <FileText className="h-8 w-8 text-muted-foreground" />
        </div>
        <h2 className="text-2xl font-semibold tracking-tight">No docs yet</h2>
        <p className="text-sm text-muted-foreground">
          Create your first document to get started. Docs help you organize and
          share knowledge within your project.
        </p>
      </div>
    </div>
  );
}

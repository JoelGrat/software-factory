import { FileText } from "lucide-react";

export default function DocsPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
        <FileText className="h-8 w-8 text-muted-foreground" />
      </div>
      <div className="text-center">
        <h2 className="text-xl font-semibold">No documents yet</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Create your first document to get started.
        </p>
      </div>
    </div>
  );
}

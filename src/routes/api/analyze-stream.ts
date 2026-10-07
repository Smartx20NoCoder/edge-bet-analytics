import { createFileRoute } from "@tanstack/react-router";
import { handleAnalyzeStream } from "@/lib/analyze-stream.server";
export const Route = createFileRoute("/api/analyze-stream")({
  server: { handlers: { GET: async ({ request }) => handleAnalyzeStream(request) } },
});

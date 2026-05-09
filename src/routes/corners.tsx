import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { getPredictions } from "@/lib/predictions.functions";
import { PredictionCard, type Prediction } from "@/components/PredictionCard";
import { RunAnalysisBar } from "@/components/RunAnalysisBar";

export const Route = createFileRoute("/corners")({
  head: () => ({
    meta: [
      { title: "Corner Predictions · BetEdge AI" },
      { name: "description", content: "Over 6.5 corner predictions from real football data with statistical scoring." },
    ],
  }),
  component: CornersPage,
});

function CornersPage() {
  const fn = useServerFn(getPredictions);
  const q = useQuery({ queryKey: ["preds", "corners"], queryFn: () => fn({ data: { engine: "corners" } }) });
  const list = (q.data?.predictions ?? []) as Prediction[];
  return (
    <section className="mx-auto max-w-7xl px-4 sm:px-6 py-10">
      <h1 className="text-3xl font-bold">Corner <span className="text-neon">Engine</span></h1>
      <p className="text-sm text-muted-foreground mt-1">Over 6.5 corners · 75%+ confidence · top 5 per scan.</p>
      <div className="mt-6"><RunAnalysisBar /></div>
      <div className="mt-8">
        {q.isLoading ? <p className="text-muted-foreground text-sm">Loading…</p> :
         list.length === 0 ? <p className="glass rounded-xl p-10 text-center text-sm text-muted-foreground">No qualifying corner picks yet.</p> :
         <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">{list.map((p) => <PredictionCard key={p.id} p={p} />)}</div>}
      </div>
    </section>
  );
}

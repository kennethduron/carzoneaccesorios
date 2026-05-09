import { PublicStoreShell } from "@/components/store/public-store-shell";

type ContentPageProps = {
  eyebrow: string;
  title: string;
  body: string;
};

export function ContentPage({ eyebrow, title, body }: ContentPageProps) {
  return (
    <PublicStoreShell>
      <section className="mx-auto max-w-4xl px-5 py-12">
        <p className="text-sm text-black/50">{eyebrow}</p>
        <h1 className="mt-2 text-4xl font-semibold">{title}</h1>
        <p className="mt-5 text-lg leading-8 text-black/65">{body}</p>
      </section>
    </PublicStoreShell>
  );
}

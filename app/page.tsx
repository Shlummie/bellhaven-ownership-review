import type { Metadata } from "next";
import { ReviewApp } from "./review-client";

export const metadata: Metadata = {
  title: "Ownership review | Bellhaven",
  description: "Evidence-led CRM ownership review for Bellhaven Senior Living.",
};

export default function Home() {
  return <ReviewApp />;
}

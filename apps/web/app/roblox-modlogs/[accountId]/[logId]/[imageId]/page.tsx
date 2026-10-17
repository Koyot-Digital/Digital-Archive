import type { Metadata } from "next";
import { ImagePage, imageMetadata, type ImagePageProps } from "@/components/subject-pages";

/** One piece of evidence, on its own citable URL. */
export const generateMetadata = (props: ImagePageProps): Promise<Metadata> =>
  imageMetadata("roblox", props);

export default function Page(props: ImagePageProps) {
  return <ImagePage platform="roblox" {...props} />;
}

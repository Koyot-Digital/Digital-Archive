import type { Metadata } from "next";
import { RecordPage, recordMetadata, type RecordPageProps } from "@/components/subject-pages";

/** archive.domain.com/roblox-modlogs/[accountId]/[16-char id] - one record. */
export const generateMetadata = (props: RecordPageProps): Promise<Metadata> =>
  recordMetadata("roblox", props);

export default function Page(props: RecordPageProps) {
  return <RecordPage platform="roblox" {...props} />;
}

import type { Metadata } from "next";
import { RecordPage, recordMetadata, type RecordPageProps } from "@/components/subject-pages";

/** archive.domain.com/discord-modlogs/[accountId]/[16-char id] - one record. */
export const generateMetadata = (props: RecordPageProps): Promise<Metadata> =>
  recordMetadata("discord", props);

export default function Page(props: RecordPageProps) {
  return <RecordPage platform="discord" {...props} />;
}

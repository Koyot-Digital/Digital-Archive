import type { Metadata } from "next";
import { SubjectPage, subjectMetadata, type SubjectPageProps } from "@/components/subject-pages";

/**
 * archive.domain.com/discord-modlogs/[accountId]
 *
 * Everything the archive holds about one Discord account. The page itself
 * lives in components/subject-pages.tsx and is shared with the other
 * platform; this file exists to bind it to a URL.
 */
export const generateMetadata = (props: SubjectPageProps): Promise<Metadata> =>
  subjectMetadata("discord", props);

export default function Page(props: SubjectPageProps) {
  return <SubjectPage platform="discord" {...props} />;
}

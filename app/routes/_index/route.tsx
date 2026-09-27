import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Catalogic</h1>
        <p className={styles.text}>
          Smart-collection-style rules for your Market and B2B catalogs, kept in sync automatically.
        </p>
        <ul className={styles.list}>
          <li>
            <strong>Rules, not spreadsheets</strong>. Decide which products each
            market or B2B catalog gets with tags, vendors, types, prices and
            metafields.
          </li>
          <li>
            <strong>New products arrive automatically</strong>. Products that
            match a catalog&apos;s rules are added as soon as they&apos;re created.
          </li>
          <li>
            <strong>No surprises</strong>. Preview every change, see manual edits,
            and find products buyers can&apos;t actually see.
          </li>
        </ul>
      </div>
    </div>
  );
}

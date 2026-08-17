import { GoogleIcon, ZoomIcon } from "./icons";

export type IntegrationId = "google" | "zoom";

export interface IntegrationDefinition {
  id: IntegrationId;
  name: string;
  description: string;
  icon: (props: { size?: number }) => JSX.Element;
  connectHref: string;
}

export const INTEGRATIONS: IntegrationDefinition[] = [
  {
    id: "google",
    name: "Google Account",
    description: "Connect Gmail so the agent can read and send messages on your behalf.",
    icon: GoogleIcon,
    connectHref: "/api/auth/google",
  },
  {
    id: "zoom",
    name: "Zoom",
    description: "Connect Zoom to schedule and join meetings automatically.",
    icon: ZoomIcon,
    connectHref: "/api/auth/zoom",
  },
];
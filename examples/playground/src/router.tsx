import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

import { ChatPlayground } from "./chat-playground";

const rootRoute = createRootRoute();

const playgroundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ChatPlayground,
});

const routeTree = rootRoute.addChildren([playgroundRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

/**
 * BrowseAgentsButton — re-exported from agents-section.tsx so callers can
 * import the popover trigger without pulling in the surrounding agents-list
 * surface. The component itself is defined as `PinAgentPopover` inside
 * agents-section.tsx; keeping the implementation co-located there avoids
 * an unnecessary cross-file dependency on the modal state it manages.
 */
export { BrowseAgentsButton } from "./agents-section";

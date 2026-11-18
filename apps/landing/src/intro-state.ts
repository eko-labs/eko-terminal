import { createContext, useContext } from "react";

/** True while the opening animation covers the landing: sections hold their videos and loops until it lifts. */
export const IntroCovered = createContext(false);
export const useIntroCovered = () => useContext(IntroCovered);

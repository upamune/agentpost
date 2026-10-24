import { test } from "vitest";
import { cases } from "./replays";

const [name, replay] = cases[7];
test(name, replay);

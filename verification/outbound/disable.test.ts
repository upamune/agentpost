import { test } from "vitest";
import { cases } from "./replays";

const [name, replay] = cases[1];
test(name, replay);

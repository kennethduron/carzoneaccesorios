import { z } from "zod";

export const productTaxCategorySchema = z.enum(["standard", "exempt"]);

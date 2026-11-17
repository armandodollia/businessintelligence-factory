/**
 * Words that say nothing about which business a name belongs to (feedback bundle redaction,
 * `redact.ts`). A word of a stored name is replaced on its own only when it is not one of these:
 * replacing "group" or "delivery" wherever it stands would damage the tester's own reasons and the
 * failure messages, and would hide nothing.
 *
 * Lower case, four characters or more (a shorter word of a name is never replaced on its own). The list
 * is modest on purpose: everyday English, the words many business names share, the words for parts of
 * a business, and the words this tool uses in its own messages. The words of the tool's own labels
 * need not be here: `redact.ts` leaves those alone already.
 */
const WORDS = `
  about above across after again against along also always among another around away because been
  before being best better between both come could does during each early even ever every first form
  found from full general give going good great half hand hard have having here into just kind know
  large last late later left less life like little long look made make many more most much must near
  need never next once only other others part past place point real right said same should show side
  since small some still such take than that their them then there these they thing things this those
  through time together turn under until used using very want well went were when where which while
  whole will with within without would year years your deep root roots tree trees node nodes idle
  dive dives wide short

  companies group groups holding holdings limited corporation corp gmbh partners partner associates
  brothers sons family international national global world regional region local central north south
  east west northern southern eastern western united american european america europe asia africa
  pacific atlantic city town state country

  software hardware digital data cloud online mobile network networks internet systems system solutions
  solution services service technology technologies tech labs studio studios media design agency
  consulting management capital ventures venture enterprises enterprise industries industrial industry
  trading traders trade supply supplies foods food health healthcare medical care energy power
  financial finance bank banking insurance retail wholesale store stores shop shops market markets
  marketing sales payments payment logistics delivery transport shipping freight express travel hotel
  hotels property properties estate construction building engineering manufacturing products product
  brand brands goods fashion beauty sport sports games music film video press books education school
  academy university institute foundation association society club union council centre center house
  home garden farm farms

  businesses customers client clients consumer consumers users people person team teams unit divisions
  department departments branch branches office offices operations support legal human resources
  security research development strategy pricing price prices plan plans premium basic standard
  professional starter free trial account accounts billing revenue growth profit cost costs budget
  budgets report reports project projects program

  agents model models task tasks runs round rounds workers council personas finding findings
  recommendation artifacts score scores rating ratings signal signals token tokens usage error errors
  failure failures timeout rate limit exit code process spawn browser page site sites login password
  requests response question questions notes reason reasons texts file files folder path values name
  names status state start stop stopped started
`;

export const COMMON_WORDS: ReadonlySet<string> = new Set(WORDS.split(/\s+/).filter(Boolean));
